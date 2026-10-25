import type { McpClient } from "~/lib/mcp/clients"

/** A client mark in a square tile, or its letters when it has no logo. */
export function ClientLogo({ client, small = false }: { client: Pick<McpClient, "logo" | "mono">; small?: boolean }) {
  const size = small ? 16 : 22
  return (
    <span className={small ? "cxlogo cxlogo--sm" : "cxlogo"}>
      {client.logo ? <img src={client.logo} alt="" width={size} height={size} /> : <b>{client.mono}</b>}
    </span>
  )
}
