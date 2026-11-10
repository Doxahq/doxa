import { McpConnectCard } from "~/components/dashboard/new-project/mcp-connect-card"
import { Dialog, DialogBody, DialogContent, DialogTitle } from "~/components/ui/dialog"

/** The MCP setup in a dialog, so that a person stays on the page that asked for it. */
export function McpConnectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overscroll-contain shadow-none sm:max-w-[1000px]">
        <DialogTitle className="sr-only">Connect an agent with MCP</DialogTitle>
        <DialogBody className="max-h-[calc(100dvh-2rem)] min-w-0 overflow-y-auto">
          <McpConnectCard insideDialog />
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
