import { createFileTree } from "@doxahq/docs-prose";
import { FiFileText } from "react-icons/fi";
import { LuFolder, LuFolderClosed } from "react-icons/lu";

/**
 * File tree icons for the published docs.
 *
 * The icon roles are deliberate and match the shipped appearance: an expanded
 * folder shows the closed glyph and a collapsed folder shows the open one. Do
 * not swap them without intending the visual change.
 */
const { FileTree, Folder, File } = createFileTree({
  folderOpen: LuFolderClosed,
  folderClosed: LuFolder,
  file: FiFileText,
});

export { Folder, File };
export default FileTree;
