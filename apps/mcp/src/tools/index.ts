import type { AnyMcpTool } from "../tool-definition";
import { cancelGenerationTool } from "./generation/cancel-generation";
import { startGenerationTool } from "./generation/start-generation";
import { addDomainTool } from "./domains/add-domain";
import { checkDomainTool } from "./domains/check-domain";
import { removeDomainTool } from "./domains/remove-domain";
import { createProjectTool } from "./projects/create-project";
import { deleteProjectTool } from "./projects/delete-project";
import { publishBranchTool } from "./publish/publish-branch";
import { restorePublicationTool } from "./publish/restore-publication";
import { cancelApprovalRequestTool } from "./requests/cancel-approval-request";
import { getApprovalRequestTool } from "./requests/get-approval-request";
import { listApprovalRequestsTool } from "./requests/list-approval-requests";
import { getAccountTool } from "./account/get-account";
import { buildPreviewTool } from "./branches/build-preview";
import { createBranchTool } from "./branches/create-branch";
import { deleteBranchTool } from "./branches/delete-branch";
import { getBranchDiffTool } from "./branches/get-branch-diff";
import { getBranchStatusTool } from "./branches/get-branch-status";
import { listBranchesTool } from "./branches/list-branches";
import { syncBranchTool } from "./branches/sync-branch";
import { createAssetUploadTool } from "./docs/create-asset-upload";
import { editDocsTool } from "./docs/edit-docs";
import { finishAssetUploadTool } from "./docs/finish-asset-upload";
import { getDocsStructureTool } from "./docs/get-docs-structure";
import { readPageTool } from "./docs/read-page";
import { searchDocsTool } from "./docs/search-docs";
import { uploadAssetTool } from "./docs/upload-asset";
import { writePageTool } from "./docs/write-page";
import { listDomainsTool } from "./domains/list-domains";
import { getGenerationTool } from "./generation/get-generation";
import { getProjectTool } from "./projects/get-project";
import { listGithubRepositoriesTool } from "./projects/list-github-repositories";
import { listProjectsTool } from "./projects/list-projects";
import { listPublicationsTool } from "./publish/list-publications";
import { getSiteSettingsTool } from "./site/get-site-settings";
import { updateSiteSettingsTool } from "./site/update-site-settings";

export const TOOLS: readonly AnyMcpTool[] = [
  getAccountTool,
  listProjectsTool,
  getProjectTool,
  listGithubRepositoriesTool,
  createProjectTool,
  deleteProjectTool,
  getDocsStructureTool,
  readPageTool,
  searchDocsTool,
  writePageTool,
  editDocsTool,
  uploadAssetTool,
  createAssetUploadTool,
  finishAssetUploadTool,
  listBranchesTool,
  createBranchTool,
  getBranchStatusTool,
  getBranchDiffTool,
  syncBranchTool,
  buildPreviewTool,
  deleteBranchTool,
  getSiteSettingsTool,
  updateSiteSettingsTool,
  publishBranchTool,
  listPublicationsTool,
  restorePublicationTool,
  getApprovalRequestTool,
  listApprovalRequestsTool,
  cancelApprovalRequestTool,
  listDomainsTool,
  addDomainTool,
  checkDomainTool,
  removeDomainTool,
  startGenerationTool,
  getGenerationTool,
  cancelGenerationTool,
];
