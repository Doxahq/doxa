# A role that GitHub Actions takes through OIDC to deploy the API: push an
# image, register a task definition revision and update the service. There
# are no long-lived AWS keys in GitHub.

locals {
  github_oidc_host = "token.actions.githubusercontent.com"
  oidc_provider_arn = (
    var.existing_oidc_provider_arn != null
    ? var.existing_oidc_provider_arn
    : aws_iam_openid_connect_provider.github[0].arn
  )
  # GitHub's environment protection rules decide which branches may deploy.
  allowed_subjects = flatten([
    for repository in var.repositories : [for name in var.environments : "repo:${repository}:environment:${name}"]
  ])
}

# An account holds one provider per URL. Pass existing_oidc_provider_arn when
# another stack already created it.
resource "aws_iam_openid_connect_provider" "github" {
  count = var.existing_oidc_provider_arn == null ? 1 : 0

  url            = "https://${local.github_oidc_host}"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "assume_from_github" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_host}:sub"
      values   = local.allowed_subjects
    }
  }
}

resource "aws_iam_role" "this" {
  name                 = var.name
  assume_role_policy   = data.aws_iam_policy_document.assume_from_github.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "deploy" {
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid = "EcrPush"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = [var.ecr_repository_arn]
  }

  # These two ECS actions do not support resource-level permissions.
  statement {
    sid       = "EcsTaskDefinitions"
    actions   = ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"]
    resources = ["*"]
  }

  # The deploy script copies the tags of the current revision to the next one.
  statement {
    sid       = "TagNewRevisions"
    actions   = ["ecs:TagResource"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "ecs:CreateAction"
      values   = ["RegisterTaskDefinition"]
    }
  }

  statement {
    sid       = "EcsService"
    actions   = ["ecs:DescribeServices", "ecs:UpdateService"]
    resources = [var.ecs_service_arn]
  }

  statement {
    sid       = "PassTaskRoles"
    actions   = ["iam:PassRole"]
    resources = var.task_role_arns

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "deploy-api"
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.deploy.json
}
