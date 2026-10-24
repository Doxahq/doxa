output "role_arn" {
  description = "ARN of the role for aws-actions/configure-aws-credentials."
  value       = aws_iam_role.this.arn
}
