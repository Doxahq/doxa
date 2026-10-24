import { LuChevronDown } from "react-icons/lu";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/src/components/ui/dropdown-menu";
import { requestClientName } from "@/src/components/api-reference/request-clients";

export function RequestClientSelect({
  clients,
  active,
  onSelect,
}: {
  clients: readonly string[];
  active: string;
  onSelect: (client: string) => void;
}) {
  if (clients.length <= 1) {
    return (
      <span className="font-code shrink-0 text-[0.7rem] text-muted-foreground">
        {requestClientName(clients[0] ?? active)}
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="font-code flex shrink-0 cursor-pointer items-center gap-1 text-[0.7rem] text-muted-foreground hover:text-foreground"
          aria-label="Select request client"
        >
          {requestClientName(active)}
          <LuChevronDown className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={active} onValueChange={onSelect}>
          {clients.map((client) => (
            <DropdownMenuRadioItem key={client} value={client}>
              {requestClientName(client)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
