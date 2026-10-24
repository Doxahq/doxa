import {
  createContext,
  memo,
  useCallback,
  useContext,
  useState,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";

import { cn } from "../lib/cn";
import type { IconComponent } from "./card";

export interface FileTreeIcons {
  /** Drawn on an expanded folder. */
  folderOpen: IconComponent;
  /** Drawn on a collapsed folder. */
  folderClosed: IconComponent;
  file: IconComponent;
}

export interface FileTreeProps {
  children?: ReactNode;
}

export interface FolderProps {
  name: string;
  label?: ReactElement;
  open?: boolean;
  defaultOpen?: boolean;
  onToggle?: (open: boolean) => void;
  children?: ReactNode;
}

export interface FileProps {
  name: string;
  label?: ReactElement;
}

export interface FileTreeComponents {
  FileTree: ComponentType<FileTreeProps>;
  Folder: ComponentType<FolderProps>;
  File: ComponentType<FileProps>;
}

const IndentContext = createContext(0);

/**
 * Builds the file tree around a host's icon set.
 *
 * The icons are injected so the package stays independent of an icon library:
 * the docs renderer ships `react-icons`, the dashboard ships `lucide-react`,
 * and neither has to adopt the other's.
 */
export function createFileTree(icons: FileTreeIcons): FileTreeComponents {
  const { folderOpen: FolderOpenIcon, folderClosed: FolderClosedIcon, file: FileIcon } = icons;

  function FileTree({ children }: FileTreeProps) {
    return (
      <ul className="m-0! w-full list-none overflow-hidden rounded-lg border p-2!">
        {children}
      </ul>
    );
  }

  const Folder = memo(function Folder({
    label,
    name,
    open,
    defaultOpen = false,
    onToggle,
    children,
  }: FolderProps) {
    const indent = useContext(IndentContext);
    const [isExpanded, setIsExpanded] = useState(defaultOpen);

    const toggle = useCallback(() => {
      onToggle?.(!isExpanded);
      setIsExpanded(!isExpanded);
    }, [isExpanded, onToggle]);

    const isOpen = open === undefined ? isExpanded : open;

    return (
      <li className="list-none">
        <div
          onClick={toggle}
          title={name}
          className="inline-flex cursor-pointer items-center py-1 text-xs transition-colors duration-75 hover:text-muted-foreground"
        >
          <span className="ml-1">
            {isOpen ? <FolderOpenIcon className="size-3.5" /> : <FolderClosedIcon className="size-3.5" />}
          </span>
          <span className="ml-2">{label ?? name}</span>
        </div>
        <div
          className={cn(
            "grid transition-[grid-template-rows] duration-100 ease-in-out",
            isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
          )}
        >
          <div className="overflow-hidden">
            <ul className="list-none pl-3!">
              <IndentContext.Provider value={indent + 1}>{children}</IndentContext.Provider>
            </ul>
          </div>
        </div>
      </li>
    );
  });

  const File = memo(function File({ label, name }: FileProps) {
    return (
      <li className="list-none">
        <div className="inline-flex cursor-default items-center py-1 text-xs transition-colors duration-75 hover:text-muted-foreground">
          <span className="ml-1">
            <FileIcon className="size-3.5" />
          </span>
          <span className="mr-2 ml-2">{label ?? name}</span>
        </div>
      </li>
    );
  });

  return { FileTree, Folder, File };
}
