import { SunMoon } from "lucide-react"

import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "~/components/ui/dropdown-menu"
import { isThemePreference, THEME_PREFERENCE_LABELS, THEME_PREFERENCES } from "~/lib/theme/theme"
import { useTheme } from "~/lib/theme/use-theme"

/**
 * The account menu row that opens the theme choices: System (the default),
 * Dark and Light. The menu stays open after a choice, so the person sees the
 * new theme on the menu itself.
 */
export function ThemeMenuItem() {
  const { preference, setPreference } = useTheme()

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <SunMoon />
        {/* The label takes the free space, so the current choice sits next to the chevron. */}
        <span className="flex-1">Theme</span>
        <span className="text-[12px] text-faint">{THEME_PREFERENCE_LABELS[preference]}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent sideOffset={6} className="w-36">
        <DropdownMenuRadioGroup
          value={preference}
          onValueChange={(value) => {
            if (isThemePreference(value)) setPreference(value)
          }}
        >
          {THEME_PREFERENCES.map((option) => (
            <DropdownMenuRadioItem key={option} value={option} onSelect={(event) => event.preventDefault()}>
              {THEME_PREFERENCE_LABELS[option]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
