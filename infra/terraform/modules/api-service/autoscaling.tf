# Target tracking on average CPU, per color. The deploy sets the bounds of a
# color's target: the stack's task count while the color serves, 0 while it
# is idle (scripts/deploy/deploy-api-ecs.mjs). Terraform sets them once, when it
# creates the target. With min equal to max, the policy never acts.

resource "aws_appautoscaling_target" "color" {
  for_each = var.colors

  service_namespace  = "ecs"
  scalable_dimension = "ecs:service:DesiredCount"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.color[each.key].name}"
  min_capacity       = each.key == local.initial_live_color ? var.min_task_count : 0
  max_capacity       = each.key == local.initial_live_color ? var.max_task_count : 0

  lifecycle {
    ignore_changes = [min_capacity, max_capacity]
  }
}

resource "aws_appautoscaling_policy" "cpu" {
  for_each = var.colors

  name               = "${each.value}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.color[each.key].service_namespace
  scalable_dimension = aws_appautoscaling_target.color[each.key].scalable_dimension
  resource_id        = aws_appautoscaling_target.color[each.key].resource_id

  target_tracking_scaling_policy_configuration {
    target_value       = var.cpu_target_percent
    scale_out_cooldown = 60
    scale_in_cooldown  = 300

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

moved {
  from = aws_appautoscaling_target.this
  to   = aws_appautoscaling_target.color["blue"]
}

moved {
  from = aws_appautoscaling_policy.cpu
  to   = aws_appautoscaling_policy.cpu["blue"]
}
