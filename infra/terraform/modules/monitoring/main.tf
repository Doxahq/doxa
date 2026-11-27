# Alerts for the API service, sent by email through one SNS topic:
#
#   no running task   no CPU samples from either color for 3 minutes
#   high CPU / memory the tasks of a color are close to their size
#   failed deploy     ECS rolled a deploy back or cannot start tasks
#   monthly budget    the AWS bill passes the limit
#   valkey            the cache nears its storage or ECPU limit, or throttles
#
# Each address gets a confirmation email from AWS and receives alerts only
# after the link in it is opened.

data "aws_caller_identity" "current" {}

locals {
  # The usage alarms per color and metric. An idle color sends no samples,
  # which counts as "not breaching".
  usage_alarms = merge([
    for color, service in var.services : {
      for metric, alarm in {
        cpu    = { metric = "CPUUtilization", threshold = var.cpu_alarm_percent }
        memory = { metric = "MemoryUtilization", threshold = var.memory_alarm_percent }
      } : "${color}-${metric}" => merge(alarm, { color = color, kind = metric, service_name = service.name })
    }
  ]...)
}

resource "aws_sns_topic" "alerts" {
  name = "${var.name}-alerts"
}

resource "aws_sns_topic_subscription" "email" {
  for_each = toset(var.alert_emails)

  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = each.value
}

data "aws_iam_policy_document" "alerts_topic" {
  statement {
    sid       = "PublishFromCloudWatchAndEventBridge"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alerts.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com", "events.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  arn    = aws_sns_topic.alerts.arn
  policy = data.aws_iam_policy_document.alerts_topic.json
}

# A running task reports CPU every minute. No sample from either color means
# that no task runs: the edge serves the live color, and the other is idle.
resource "aws_cloudwatch_metric_alarm" "no_running_task" {
  alarm_name          = "${var.name}-no-running-task"
  alarm_description   = "The API has had no running task for 3 minutes."
  evaluation_periods  = 3
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]

  metric_query {
    id          = "samples"
    expression  = join(" + ", [for color in sort(keys(var.services)) : "FILL(${color}, 0)"])
    label       = "CPU samples of all colors"
    return_data = true
  }

  dynamic "metric_query" {
    for_each = var.services

    content {
      id = metric_query.key

      metric {
        namespace   = "AWS/ECS"
        metric_name = "CPUUtilization"
        dimensions  = { ClusterName = var.cluster_name, ServiceName = metric_query.value.name }
        stat        = "SampleCount"
        period      = 60
      }
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "high_usage" {
  for_each = local.usage_alarms

  alarm_name          = "${each.value.service_name}-high-${each.value.kind}"
  alarm_description   = "Average ${each.value.kind} use of the ${each.value.color} API service is above ${each.value.threshold}% for 10 minutes."
  namespace           = "AWS/ECS"
  metric_name         = each.value.metric
  dimensions          = { ClusterName = var.cluster_name, ServiceName = each.value.service_name }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  comparison_operator = "GreaterThanThreshold"
  threshold           = each.value.threshold
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_event_rule" "failed_deploy" {
  name        = "${var.name}-failed-deploy"
  description = "ECS deploy failures and task start problems of the API services."

  event_pattern = jsonencode({
    source        = ["aws.ecs"]
    resources     = sort([for service in values(var.services) : service.arn])
    "detail-type" = ["ECS Deployment State Change", "ECS Service Action"]
    detail = {
      eventName = [
        "SERVICE_DEPLOYMENT_FAILED",
        "SERVICE_TASK_START_IMPAIRED",
        "SERVICE_TASK_PLACEMENT_FAILURE",
      ]
    }
  })
}

resource "aws_cloudwatch_event_target" "failed_deploy" {
  rule = aws_cloudwatch_event_rule.failed_deploy.name
  arn  = aws_sns_topic.alerts.arn
}

resource "aws_budgets_budget" "monthly" {
  name         = "${var.name}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "notification" {
    for_each = var.budget_notifications

    content {
      notification_type          = notification.value.type
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value.threshold_percent
      threshold_type             = "PERCENTAGE"
      subscriber_email_addresses = var.alert_emails
    }
  }
}

# Valkey holds the sessions and the OAuth state. At its storage or ECPU limit
# the cache refuses writes or throttles, and sign-in fails for everyone, so
# alert well before a limit (SEC-008).
resource "aws_cloudwatch_metric_alarm" "valkey_usage" {
  for_each = var.valkey == null ? {} : {
    storage = {
      metric      = "BytesUsedForCache"
      statistic   = "Maximum"
      threshold   = var.valkey.max_data_storage_gb * 1024 * 1024 * 1024 * var.valkey_alarm_percent / 100
      description = "Valkey stores more than ${var.valkey_alarm_percent}% of its ${var.valkey.max_data_storage_gb} GB limit."
    }
    # The metric counts ECPUs per period, and the limit is per second.
    ecpu = {
      metric      = "ElastiCacheProcessingUnits"
      statistic   = "Sum"
      threshold   = var.valkey.max_ecpu_per_second * 60 * var.valkey_alarm_percent / 100
      description = "Valkey uses more than ${var.valkey_alarm_percent}% of its ${var.valkey.max_ecpu_per_second} ECPU per second limit."
    }
  }

  alarm_name          = "${var.name}-valkey-${each.key}"
  alarm_description   = each.value.description
  namespace           = "AWS/ElastiCache"
  metric_name         = each.value.metric
  dimensions          = { clusterId = var.valkey.cache_name }
  statistic           = each.value.statistic
  period              = 60
  evaluation_periods  = 5
  comparison_operator = "GreaterThanThreshold"
  threshold           = each.value.threshold
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# Any throttled command means the ECPU limit was reached.
resource "aws_cloudwatch_metric_alarm" "valkey_throttled" {
  count = var.valkey == null ? 0 : 1

  alarm_name          = "${var.name}-valkey-throttled"
  alarm_description   = "Valkey throttled commands at its ECPU limit."
  namespace           = "AWS/ElastiCache"
  metric_name         = "ThrottledCmds"
  dimensions          = { clusterId = var.valkey.cache_name }
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

moved {
  from = aws_cloudwatch_metric_alarm.high_usage["cpu"]
  to   = aws_cloudwatch_metric_alarm.high_usage["blue-cpu"]
}

moved {
  from = aws_cloudwatch_metric_alarm.high_usage["memory"]
  to   = aws_cloudwatch_metric_alarm.high_usage["blue-memory"]
}
