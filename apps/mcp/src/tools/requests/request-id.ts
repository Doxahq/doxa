import { z } from "zod";

export const requestIdInput = z.uuid().describe("The request ID, from an approval_required result.");
