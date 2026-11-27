# Two services of the same task, blue and green. The edge Worker sends
# traffic to one of them; the other runs no task between releases. A release
# starts the new image on the idle color, switches the edge, and stops the
# old color after a while (scripts/deploy/release.mjs).
#
# Terraform creates blue with min_task_count tasks and green with none. After
# that the deploy owns the revision and the task count of each color.

locals {
  # The color that serves when Terraform creates the services.
  initial_live_color = "blue"
}

resource "aws_ecs_service" "color" {
  for_each = var.colors

  name             = each.value
  cluster          = aws_ecs_cluster.this.id
  task_definition  = aws_ecs_task_definition.color[each.key].arn
  desired_count    = each.key == local.initial_live_color ? var.min_task_count : 0
  launch_type      = "FARGATE"
  platform_version = "LATEST"

  enable_execute_command  = var.enable_execute_command
  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"

  # Within one color, a deploy starts the new task, waits until it is
  # healthy, then stops the old one. A deploy whose tasks keep failing rolls
  # back to the last working revision.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = true
  }

  lifecycle {
    # The deploy script owns the running revision and the task count.
    # Terraform changes to the task definition reach a color with the next
    # deploy, which starts from the latest revision of the family.
    ignore_changes = [task_definition, desired_count]
  }
}

moved {
  from = aws_ecs_service.this
  to   = aws_ecs_service.color["blue"]
}
