output "cluster_name" {
  description = "Name of the ECS cluster."
  value       = aws_ecs_cluster.this.name
}

output "service_names" {
  description = "Color => name of the ECS service."
  value       = { for color, service in aws_ecs_service.color : color => service.name }
}

output "service_arns" {
  description = "Color => ARN of the ECS service."
  value       = { for color, service in aws_ecs_service.color : color => service.id }
}

output "security_group_id" {
  description = "Security group of the tasks, for the stores they connect to."
  value       = aws_security_group.tasks.id
}

output "task_definition_families" {
  description = "Color => task definition family that deploys register new revisions in."
  value       = { for color, definition in aws_ecs_task_definition.color : color => definition.family }
}

output "api_container_name" {
  description = "Name of the API container, whose image a deploy replaces."
  value       = local.api_container_name
}

output "execution_role_arn" {
  description = "ARN of the task execution role."
  value       = aws_iam_role.execution.arn
}

output "task_role_arn" {
  description = "ARN of the task role."
  value       = aws_iam_role.task.arn
}

output "log_group_name" {
  description = "CloudWatch log group of both containers."
  value       = aws_cloudwatch_log_group.this.name
}
