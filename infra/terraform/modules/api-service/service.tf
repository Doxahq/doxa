resource "aws_ecs_service" "this" {
  name             = var.name
  cluster          = aws_ecs_cluster.this.id
  task_definition  = aws_ecs_task_definition.this.arn
  desired_count    = var.min_task_count
  launch_type      = "FARGATE"
  platform_version = "LATEST"

  enable_execute_command  = var.enable_execute_command
  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"

  # Rolling deploy with no capacity loss: start the new task, wait until it
  # is healthy, then stop the old one. A deploy whose tasks keep failing rolls
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
    # The deploy script owns the running revision, and autoscaling owns the
    # task count. Terraform changes to the task definition reach the service
    # with the next deploy, which starts from the latest revision.
    ignore_changes = [task_definition, desired_count]
  }
}
