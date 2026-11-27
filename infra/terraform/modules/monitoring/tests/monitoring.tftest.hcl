# Offline tests: the AWS provider is mocked, so nothing reaches AWS.
# Run with `terraform test` in modules/monitoring.

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }

  mock_data "aws_iam_policy_document" {
    defaults = { json = "{}" }
  }

  mock_resource "aws_sns_topic" {
    defaults = { arn = "arn:aws:sns:us-east-1:123456789012:doxa-api-test-alerts" }
  }
}

variables {
  name         = "doxa-api-test"
  cluster_name = "doxa-api-test"
  services = {
    blue  = { name = "doxa-api-test", arn = "arn:aws:ecs:us-east-1:123456789012:service/doxa-api-test/doxa-api-test" }
    green = { name = "doxa-api-test-green", arn = "arn:aws:ecs:us-east-1:123456789012:service/doxa-api-test/doxa-api-test-green" }
  }
  alert_emails = ["alerts@example.com"]
}

run "alerts_when_neither_color_runs_a_task" {
  command = plan

  assert {
    condition     = one([for query in aws_cloudwatch_metric_alarm.no_running_task.metric_query : query.expression if query.return_data == true]) == "FILL(blue, 0) + FILL(green, 0)"
    error_message = "The no-running-task alarm must add the CPU samples of both colors: the idle color sends none."
  }

  assert {
    condition     = toset([for query in aws_cloudwatch_metric_alarm.no_running_task.metric_query : one(query.metric).dimensions.ServiceName if length(query.metric) > 0]) == toset(["doxa-api-test", "doxa-api-test-green"])
    error_message = "The alarm must read the CPU samples of each color's service."
  }
}

run "watches_the_usage_and_the_deploys_of_each_color" {
  command = plan

  assert {
    condition     = toset(keys(aws_cloudwatch_metric_alarm.high_usage)) == toset(["blue-cpu", "blue-memory", "green-cpu", "green-memory"])
    error_message = "Each color must have its own CPU and memory alarm."
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.high_usage["blue-cpu"].alarm_name == "doxa-api-test-high-cpu"
    error_message = "Blue must keep the alarm names from before blue/green."
  }

  assert {
    condition     = jsondecode(aws_cloudwatch_event_rule.failed_deploy.event_pattern).resources == [var.services.blue.arn, var.services.green.arn]
    error_message = "A failed deploy of either color must raise an alert."
  }
}

run "adds_no_valkey_alarms_without_a_cache" {
  command = plan

  assert {
    condition     = length(aws_cloudwatch_metric_alarm.valkey_usage) == 0 && length(aws_cloudwatch_metric_alarm.valkey_throttled) == 0
    error_message = "Without valkey there must be no cache alarms."
  }
}

run "alerts_at_80_percent_of_the_valkey_limits" {
  command = plan

  variables {
    valkey = { cache_name = "doxa-api-test", max_data_storage_gb = 1, max_ecpu_per_second = 5000 }
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.valkey_usage["storage"].threshold == 858993459.2
    error_message = "The storage alarm must fire at 80% of 1 GB."
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.valkey_usage["ecpu"].threshold == 240000
    error_message = "The ECPU alarm must fire at 80% of 5000 ECPU per second over one minute."
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.valkey_throttled[0].dimensions.clusterId == "doxa-api-test"
    error_message = "The throttle alarm must watch the cache by its clusterId."
  }
}

run "sends_budget_notices_at_80_percent_actual_and_100_percent_forecast_by_default" {
  command = plan

  assert {
    condition     = toset([for notice in aws_budgets_budget.monthly.notification : "${notice.notification_type}:${notice.threshold}"]) == toset(["ACTUAL:80", "FORECASTED:100"])
    error_message = "Without budget_notifications the budget must notify at 80% actual and 100% forecast."
  }
}

run "sends_each_listed_budget_notice_to_every_alert_email" {
  command = plan

  variables {
    alert_emails = ["alerts@example.com", "billing@example.com"]
    budget_notifications = [
      { type = "ACTUAL", threshold_percent = 20 },
      { type = "ACTUAL", threshold_percent = 80 },
      { type = "FORECASTED", threshold_percent = 100 },
    ]
  }

  assert {
    condition     = toset([for notice in aws_budgets_budget.monthly.notification : "${notice.notification_type}:${notice.threshold}"]) == toset(["ACTUAL:20", "ACTUAL:80", "FORECASTED:100"])
    error_message = "The budget must hold one notice per listed level."
  }

  assert {
    condition     = alltrue([for notice in aws_budgets_budget.monthly.notification : toset(notice.subscriber_email_addresses) == toset(["alerts@example.com", "billing@example.com"])])
    error_message = "Every budget notice must go to every alert email."
  }
}

run "rejects_a_budget_notice_of_an_unknown_type" {
  command = plan

  variables {
    budget_notifications = [{ type = "MONTHLY", threshold_percent = 80 }]
  }

  expect_failures = [var.budget_notifications]
}
