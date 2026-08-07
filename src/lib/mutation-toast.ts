import { toast } from "sonner";

export function toastMutationError(action: string, error: unknown) {
  const message =
    error instanceof Error ? error.message : "Something went wrong.";
  toast.error(`Could not ${action}`, { description: message });
}
