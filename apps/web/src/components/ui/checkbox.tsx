import * as React from "react"
import { Check } from "lucide-react"

import { cn } from "~/lib/utils"

/**
 * A native checkbox drawn in the dashboard theme. It stays an `<input>`, so
 * labels, forms and tests treat it as a normal checkbox. `className` styles
 * the outer box, for margins and alignment.
 */
const Checkbox = React.forwardRef<HTMLInputElement, Omit<React.ComponentProps<"input">, "type">>(
  ({ className, ...props }, ref) => {
    return (
      <span className={cn("relative inline-flex size-4 shrink-0 has-disabled:opacity-50", className)}>
        <input
          type="checkbox"
          ref={ref}
          className="peer size-4 cursor-pointer appearance-none rounded-sm border border-input bg-input-background transition-colors duration-75 checked:border-primary checked:bg-primary enabled:not-checked:hover:border-muted-foreground disabled:cursor-not-allowed"
          {...props}
        />
        <Check
          aria-hidden="true"
          strokeWidth={3}
          className="pointer-events-none absolute inset-0 m-auto size-3 text-primary-foreground opacity-0 transition-opacity duration-75 peer-checked:opacity-100"
        />
      </span>
    )
  }
)
Checkbox.displayName = "Checkbox"

export { Checkbox }
