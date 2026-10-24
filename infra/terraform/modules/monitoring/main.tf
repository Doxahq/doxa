# Alerts for the API service, sent by email through one SNS topic:
#
#   no running task   no CPU samples for 3 minutes
#   high CPU / memory the task is close to its size
#   failed deploy     ECS rolled a deploy back or cannot start tasks
#   monthly budget    the AWS bill passes the limit
#
# Each address gets a confirmation email from AWS and receives alerts only
# after the link in it is opened.

data "aws_caller_identity" "current" {}

locals {
  service_dimensions = {
    ClusterName = var.cluster_name
    ServiceName = var.service_name
  }
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

# A running task reports CPU every minute. No sample means no task runs.
resource "aws_cloudwatch_metric_alarm" "no_running_task" {
  alarm_name          = "${var.name}-no-running-task"
  alarm_description   = "The API service has had no running task for 3 minutes."
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  dimensions          = local.service_dimensions
  statistic           = "SampleCount"
  period              = 60
  evaluation_periods  = 3
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

resource "aws_cloudwatch_metric_alarm" "high_usage" {
  for_each = {
    cpu    = { metric = "CPUUtilization", threshold = var.cpu_alarm_percent }
    memory = { metric = "MemoryUtilization", threshold = var.memory_alarm_percent }
  }

  alarm_name          = "${var.name}-high-${each.key}"
  alarm_description   = "Average ${each.key} use of the API service is above ${each.value.threshold}% for 10 minutes."
  namespace           = "AWS/ECS"
  metric_name         = each.value.metric
  dimensions          = local.service_dimensions
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
  description = "ECS deploy failures and task start problems of the API service."

  event_pattern = jsonencode({
    source        = ["aws.ecs"]
    resources     = [var.service_arn]
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

  notification {
    notification_type          = "ACTUAL"
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    subscriber_email_addresses = var.alert_emails
  }

  notification {
    notification_type          = "FORECASTED"
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    subscriber_email_addresses = var.alert_emails
  }
}
