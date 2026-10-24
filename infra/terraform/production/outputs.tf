output "ecr_repository_url" {
  description = "Repository to push API images to."
  value       = module.container_registry.repository_url
}

output "cluster_name" {
  description = "ECS cluster of the API."
  value       = module.api_service.cluster_name
}

output "service_name" {
  description = "ECS service of the API."
  value       = module.api_service.service_name
}

output "task_definition_family" {
  description = "Task definition family of the API."
  value       = module.api_service.task_definition_family
}

output "api_container_name" {
  description = "Container whose image a deploy replaces."
  value       = module.api_service.api_container_name
}

output "log_group_name" {
  description = "Log group of the API and cloudflared, for `aws logs tail`."
  value       = module.api_service.log_group_name
}

output "origin_vpc_service_id" {
  description = "Workers VPC Service of the origin: the service_id of the ORIGIN binding in apps/api-edge/wrangler.json."
  value       = module.tunnel.vpc_service_id
}

output "github_deploy_role_arn" {
  description = "Role for the deploy workflow (aws-actions/configure-aws-credentials)."
  value       = module.github_deploy.role_arn
}

output "ssm_secret_prefix" {
  description = "SSM path of the API secrets."
  value       = local.ssm_prefix
}

output "put_secret_command" {
  description = "Command to write one API secret. Replace NAME and VALUE."
  value       = "aws ssm put-parameter --region ${var.aws_region} --type SecureString --name '${local.ssm_prefix}/NAME' --value 'VALUE'"
}
