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
  service_name = "doxa-api-test"
  service_arn  = "arn:aws:ecs:us-east-1:123456789012:service/doxa-api-test/doxa-api-test"
  alert_emails = ["alerts@example.com"]
}

run "keeps_the_alarm_on_all_day_without_a_daily_pause" {
  command = plan

  assert {
    condition     = length(aws_cloudwatch_alarm_mute_rule.daily_pause) == 0
    error_message = "Without daily_pause the no-running-task alarm must never be muted."
  }
}

run "mutes_the_no_running_task_alarm_during_the_daily_pause" {
  command = apply

  variables {
    daily_pause = { stop_hour = 1, start_hour = 10, timezone = "Africa/Algiers" }
  }

  assert {
    condition     = one(one(aws_cloudwatch_alarm_mute_rule.daily_pause[0].rule).schedule).expression == "cron(0 1 * * ?)"
    error_message = "The mute must start at the stop hour."
  }

  assert {
    condition     = one(one(aws_cloudwatch_alarm_mute_rule.daily_pause[0].rule).schedule).duration == "PT9H15M"
    error_message = "The mute must last until 15 minutes after the start hour."
  }

  assert {
    condition     = one(one(aws_cloudwatch_alarm_mute_rule.daily_pause[0].rule).schedule).timezone == "Africa/Algiers"
    error_message = "The mute must use the timezone of the pause."
  }

  assert {
    condition     = one(aws_cloudwatch_alarm_mute_rule.daily_pause[0].mute_targets).alarm_names == toset(["doxa-api-test-no-running-task"])
    error_message = "The mute must target only the no-running-task alarm."
  }
}

run "mutes_a_daily_pause_across_midnight" {
  command = plan

  variables {
    daily_pause = { stop_hour = 22, start_hour = 6, timezone = "UTC" }
  }

  assert {
    condition     = one(one(aws_cloudwatch_alarm_mute_rule.daily_pause[0].rule).schedule).duration == "PT8H15M"
    error_message = "A pause from 22:00 to 06:00 must mute the alarm for 8 hours and 15 minutes."
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
