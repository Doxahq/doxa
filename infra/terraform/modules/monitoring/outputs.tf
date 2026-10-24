output "alerts_topic_arn" {
  description = "SNS topic that receives every alert."
  value       = aws_sns_topic.alerts.arn
}
