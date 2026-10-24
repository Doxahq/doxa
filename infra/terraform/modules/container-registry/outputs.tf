output "repository_arn" {
  description = "ARN of the ECR repository."
  value       = aws_ecr_repository.this.arn
}

output "repository_url" {
  description = "URL to tag and push images to, without a tag."
  value       = aws_ecr_repository.this.repository_url
}
