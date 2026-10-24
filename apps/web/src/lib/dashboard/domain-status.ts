import type { DocsDomainDto } from "@doxahq/contracts"

export type DocsDomainStageState = "ready" | "checking" | "failed"
export type DocsDomainStatusTone = "muted" | "success" | "warning" | "danger"

export interface DocsDomainStage {
  label: "Hostname" | "TLS" | "Delivery"
  state: DocsDomainStageState
  detail: string
}

export interface DocsDomainStatusView {
  overall: {
    label: "Ready" | "Setting up" | "Needs attention" | "Disabled"
    tone: DocsDomainStatusTone
  }
  stages: DocsDomainStage[]
  summary: string
}

const FAILED_PROVIDER_STATUSES = new Set([
  "blocked",
  "deleted",
  "failed",
  "validation_timed_out",
])

export function getDocsDomainStatus(domain: DocsDomainDto): DocsDomainStatusView {
  const stages = [
    getHostnameStage(domain),
    getTlsStage(domain),
    getDeliveryStage(domain),
  ]

  if (domain.status === "disabled") {
    return {
      overall: { label: "Disabled", tone: "muted" },
      stages,
      summary: "This domain is disabled and no longer routes to this project.",
    }
  }

  if (stages.some((stage) => stage.state === "failed")) {
    return {
      overall: { label: "Needs attention", tone: "danger" },
      stages,
      summary: getFailureSummary(domain),
    }
  }

  if (stages.every((stage) => stage.state === "ready")) {
    return {
      overall: { label: "Ready", tone: "success" },
      stages,
      summary: "The hostname, certificate, and documentation delivery are working.",
    }
  }

  return {
    overall: { label: "Setting up", tone: "warning" },
    stages,
    summary: "Complete the DNS setup, then check again to validate the hostname, certificate, and delivery.",
  }
}

function getHostnameStage(domain: DocsDomainDto): DocsDomainStage {
  if (isProviderFailure(domain.providerStatus)) {
    return { label: "Hostname", state: "failed", detail: formatStatus(domain.providerStatus) }
  }

  if (domain.providerStatus === "active" || isManagedDomainReady(domain)) {
    return { label: "Hostname", state: "ready", detail: "Active" }
  }

  return { label: "Hostname", state: "checking", detail: formatStatus(domain.providerStatus) }
}

function getFailureSummary(domain: DocsDomainDto): string {
  if (domain.routingStatus === "failed") {
    return "The hostname and certificate can be active while delivery to the docs renderer still fails."
  }

  return "Cloudflare could not finish the hostname or certificate check. Review the details below, then check again."
}

function getTlsStage(domain: DocsDomainDto): DocsDomainStage {
  if (domain.verificationStatus === "failed" || isProviderFailure(domain.providerSslStatus)) {
    return { label: "TLS", state: "failed", detail: formatStatus(domain.providerSslStatus) }
  }

  if (domain.providerSslStatus === "active" || isManagedDomainReady(domain)) {
    return { label: "TLS", state: "ready", detail: "Certificate active" }
  }

  return { label: "TLS", state: "checking", detail: formatStatus(domain.providerSslStatus) }
}

function getDeliveryStage(domain: DocsDomainDto): DocsDomainStage {
  if (domain.routingStatus === "failed") {
    return {
      label: "Delivery",
      state: "failed",
      detail: domain.routingHttpStatus ? `HTTP ${domain.routingHttpStatus}` : "Check failed",
    }
  }

  if (domain.routingStatus === "healthy") {
    return {
      label: "Delivery",
      state: "ready",
      detail: "Responding",
    }
  }

  if (isManagedDomainReady(domain)) {
    return { label: "Delivery", state: "ready", detail: "Managed by Doxa" }
  }

  return {
    label: "Delivery",
    state: "checking",
    detail: domain.verificationStatus === "verified" ? "Waiting for check" : "Waiting for TLS",
  }
}

function isManagedDomainReady(domain: DocsDomainDto): boolean {
  return domain.kind === "doxa_subdomain"
    && domain.status === "active"
    && domain.verificationStatus === "verified"
}

function isProviderFailure(status: string | null): boolean {
  return status !== null && FAILED_PROVIDER_STATUSES.has(status)
}

function formatStatus(status: string | null): string {
  return status ? status.replace(/_/g, " ") : "Pending"
}
