# Target tracking on average CPU. With min_task_count equal to max_task_count,
# the target pins the task count and the policy never acts.

resource "aws_appautoscaling_target" "this" {
  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.this.name}"
  min_capacity       = var.min_task_count
  max_capacity       = var.max_task_count
}

resource "aws_appautoscaling_policy" "cpu" {
  name               = "${var.name}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.this.service_namespace
  scalable_dimension = aws_appautoscaling_target.this.scalable_dimension
  resource_id        = aws_appautoscaling_target.this.resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = var.cpu_target_percent
    scale_out_cooldown = 60
    scale_in_cooldown  = 300

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

# Optional daily pause. Each scheduled action sets the bounds of the target,
# and the target moves the task count into them: 0 at stop_hour, the day
# bounds at start_hour. An apply during the pause restores the day bounds, so
# the task runs again until the next stop_hour.

resource "aws_appautoscaling_scheduled_action" "stop" {
  count = var.daily_pause == null ? 0 : 1

  name               = "${var.name}-daily-stop"
  service_namespace  = aws_appautoscaling_target.this.service_namespace
  scalable_dimension = aws_appautoscaling_target.this.scalable_dimension
  resource_id        = aws_appautoscaling_target.this.resource_id
  schedule           = "cron(0 ${var.daily_pause.stop_hour} * * ? *)"
  timezone           = var.daily_pause.timezone

  scalable_target_action {
    min_capacity = "0"
    max_capacity = "0"
  }
}

resource "aws_appautoscaling_scheduled_action" "start" {
  count = var.daily_pause == null ? 0 : 1

  name               = "${var.name}-daily-start"
  service_namespace  = aws_appautoscaling_target.this.service_namespace
  scalable_dimension = aws_appautoscaling_target.this.scalable_dimension
  resource_id        = aws_appautoscaling_target.this.resource_id
  schedule           = "cron(0 ${var.daily_pause.start_hour} * * ? *)"
  timezone           = var.daily_pause.timezone

  scalable_target_action {
    min_capacity = tostring(var.min_task_count)
    max_capacity = tostring(var.max_task_count)
  }

  # Application Auto Scaling can reject two changes to one target at the same time.
  depends_on = [aws_appautoscaling_scheduled_action.stop]
}
