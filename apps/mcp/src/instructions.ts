/** Sent to the agent at initialize. It explains the workflow (spec 9.2). */
export const DOXA_SERVER_INSTRUCTIONS = `Doxa hosts documentation sites generated from code repositories.

Workflow:
1. Call list_projects to find the project, then get_docs_structure to see its pages. On "main", the read tools show the live, published site.
2. Never edit main. Call create_branch for your changes (start the name with "agent-"). Pass its ID as branch to every write tool.
3. Read a page with read_page on your branch, then change it with write_page or edit_docs. Pass the revision you read as expectedRevision. Change site settings with update_site_settings. Read doxa://reference/mdx for the supported MDX components. To add an image from a file, call create_asset_upload on your branch, PUT the file to the returned URL (for example with the returned curl command), then call finish_asset_upload and put the returned path in the page. Use upload_asset with base64 only for a small image when you cannot run commands.
4. Call get_branch_diff to check your changes, then call build_preview and give the preview URL to the user.
5. Call publish_branch with a short summary. A publish is blocked while a changed page has MDX issues. The user reviews and approves the publish in the Doxa dashboard. After the publish, or when you abandon the work, delete your branch with delete_branch.
6. If get_branch_status reports the branch behind main, call sync_branch (dry run first).

Some actions need the user's approval. Such a tool returns outcome "approval_required" with an approval link. Give the link to the user, then check the request with get_approval_request no more often than pollAfterMs. If your client supports MCP Tasks, it gets a task for such a call instead: the client shows the link and returns the result when the user decides, so you do not poll.

Prompts give tested workflows: write_guide, update_from_code_change, review_branch, and fix_broken_links. Each takes a projectId.

search_docs searches the live site. Pass your branch ID as branch to also search your unpublished pages.
When a tool fails, read error.code and follow error.hint.`;
