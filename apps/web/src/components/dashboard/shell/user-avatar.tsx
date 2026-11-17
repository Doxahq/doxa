import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar"
import { userInitials } from "~/lib/dashboard/user-initials"
import { cn } from "~/lib/utils"

/**
 * How long a picture can load before the initials show. A cached picture
 * loads first, so the avatar does not change from initials to the picture.
 */
const PICTURE_GRACE_MS = 600

/**
 * The signed-in person's avatar: their picture (see `userAvatarUrl`), else the
 * initials of their name or email. Decorative: the email is next to it.
 */
export function UserAvatar({
  image,
  name,
  className,
}: {
  image: string | null | undefined
  name: string
  className?: string
}) {
  return (
    <Avatar aria-hidden="true" className={cn("border border-border", className)}>
      {image ? <AvatarImage src={image} alt="" referrerPolicy="no-referrer" /> : null}
      <AvatarFallback
        delayMs={image ? PICTURE_GRACE_MS : undefined}
        className="bg-secondary font-mono text-[10.5px] font-medium uppercase"
      >
        {name ? userInitials(name) : null}
      </AvatarFallback>
    </Avatar>
  )
}
