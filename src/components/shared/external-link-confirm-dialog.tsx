import { Copy, ExternalLink, X } from "lucide-react";
import { toast } from "sonner";
import { openExternalUrl } from "@/lib/open-external";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

interface ExternalLinkConfirmDialogProps {
  open: boolean;
  url: string;
  onClose: () => void;
}

export function ExternalLinkConfirmDialog({
  open,
  url,
  onClose,
}: ExternalLinkConfirmDialogProps) {
  async function handleOpen() {
    try {
      await openExternalUrl(url);
      onClose();
    } catch {
      toast.error("Could not open the external link.");
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Link copied");
    } catch {
      toast.error("Could not copy the link.");
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onClose()}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <ExternalLink className="h-4 w-4 shrink-0" />
            Open external link?
          </AlertDialogTitle>
          <AlertDialogDescription>
            You&apos;re about to visit an external website.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono text-xs break-all text-foreground">
          {url}
        </div>

        <AlertDialogFooter className="sm:justify-between">
          <AlertDialogCancel render={<Button variant="outline" />}>
            <X className="h-3.5 w-3.5" />
            Cancel
          </AlertDialogCancel>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button type="button" variant="outline" onClick={() => void handleCopy()}>
              <Copy className="h-3.5 w-3.5" />
              Copy link
            </Button>
            <Button type="button" onClick={() => void handleOpen()}>
              <ExternalLink className="h-3.5 w-3.5" />
              Open link
            </Button>
          </div>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
