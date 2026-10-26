# Two roles, as ECS requires:
#
#   execution role  used by ECS to pull images, write logs and read secrets
#   task role       used by the code in the containers
#
# The API reaches R2, Valkey and Postgres with its own credentials, so the task
# role only carries the ECS Exec channel.

data "aws_iam_policy_document" "ecs_tasks_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    # Only tasks of this account may take the role.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${local.partition}:ecs:${local.region}:${local.account_id}:*"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume_role.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:${local.partition}:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "read_secrets" {
  statement {
    sid       = "ReadTaskSecrets"
    actions   = ["ssm:GetParameters"]
    resources = local.secret_parameter_arns
  }
}

resource "aws_iam_role_policy" "execution_read_secrets" {
  name   = "read-task-secrets"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.read_secrets.json
}

resource "aws_iam_role" "task" {
  name               = "${var.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume_role.json
}

data "aws_iam_policy_document" "execute_command" {
  statement {
    sid = "EcsExecChannel"
    actions = [
      "ssmmessages:CreateControlChannel",
      "ssmmessages:CreateDataChannel",
      "ssmmessages:OpenControlChannel",
      "ssmmessages:OpenDataChannel",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "task_execute_command" {
  count = var.enable_execute_command ? 1 : 0

  name   = "ecs-exec"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.execute_command.json
}

# The origin trades an AWS-signed identity token for a short-lived Anthropic
# token (Workload Identity Federation), so no static model key is stored.
# The Anthropic federation rule accepts tokens from this role only. The
# account-level "Outbound web identity federation" setting must be on.
data "aws_iam_policy_document" "web_identity_token" {
  statement {
    sid       = "GetWebIdentityToken"
    actions   = ["sts:GetWebIdentityToken"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "task_web_identity_token" {
  name   = "get-web-identity-token"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.web_identity_token.json
}
