import { useSiteConfig } from "@/src/site-config/site-config-context";
import { LuMessageSquare, LuPencil } from "react-icons/lu";

interface SideBarEdit {
  title: string;
  slug: string;
}

export default function RightSideBar({ slug, title }: SideBarEdit) {
  const { navbar } = useSiteConfig();
  if (!navbar.github) return null;

  const feedbackUrl = `${navbar.github}/issues/new?title=${encodeURIComponent(`Feedback for "${title}"`)}&labels=feedback`;
  const editUrl = `${navbar.github}/edit/main/contents/docs/${slug}/index.mdx`;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1.5">
        <a
          href={feedbackUrl}
          title="Give Feedback"
          aria-label="Give Feedback"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <LuMessageSquare className="h-3.5 w-3.5" />
          <span>Feedback</span>
        </a>
        <a
          href={editUrl}
          title="Edit this page"
          aria-label="Edit this page"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <LuPencil className="h-3.5 w-3.5" />
          <span>Edit this page</span>
        </a>
      </div>
    </div>
  );
}
