import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PromptInput,
  PromptInputProvider,
  usePromptInputAttachments,
} from "./prompt-input";

const originalCreateObjectUrl = URL.createObjectURL;
const originalRevokeObjectUrl = URL.revokeObjectURL;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: originalCreateObjectUrl,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: originalRevokeObjectUrl,
  });
});

function AttachmentCount() {
  const attachments = usePromptInputAttachments();
  return <output aria-label="Attachment count">{attachments.files.length}</output>;
}

function stubAttachmentObjectUrls() {
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:synthetic-attachment"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
}

describe("PromptInput attachments", () => {
  it("accepts supported text extensions when the browser omits a MIME type", () => {
    stubAttachmentObjectUrls();

    render(
      <PromptInputProvider>
        <PromptInput accept=".md,.txt" onSubmit={vi.fn()}>
          <AttachmentCount />
        </PromptInput>
      </PromptInputProvider>,
    );

    fireEvent.change(screen.getByLabelText("Upload files"), {
      target: {
        files: [new File(["synthetic note"], "reference.md")],
      },
    });

    expect(screen.getByLabelText("Attachment count")).toHaveTextContent("1");
  });

  it("reads the selected File directly and strips it from the submitted payload", async () => {
    stubAttachmentObjectUrls();
    const fetchMock = vi.fn().mockRejectedValue(new Error("blocked"));
    vi.stubGlobal("fetch", fetchMock);
    const onSubmit = vi.fn();

    render(
      <PromptInputProvider>
        <PromptInput onSubmit={onSubmit}>
          <button type="submit">Send</button>
        </PromptInput>
      </PromptInputProvider>,
    );

    fireEvent.change(screen.getByLabelText("Upload files"), {
      target: {
        files: [
          new File(["synthetic pdf"], "review.pdf", {
            type: "application/pdf",
          }),
        ],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]?.[0].files).toEqual([
      {
        filename: "review.pdf",
        mediaType: "application/pdf",
        type: "file",
        url: expect.stringMatching(/^data:application\/pdf;base64,/),
      },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a selected file above the configured Agent attachment limit", () => {
    stubAttachmentObjectUrls();
    const onError = vi.fn();

    render(
      <PromptInputProvider>
        <PromptInput
          maxFileSize={2 * 1024 * 1024}
          onError={onError}
          onSubmit={vi.fn()}
        >
          <AttachmentCount />
        </PromptInput>
      </PromptInputProvider>,
    );

    fireEvent.change(screen.getByLabelText("Upload files"), {
      target: {
        files: [
          new File([new Uint8Array(2 * 1024 * 1024 + 1)], "oversized.pdf", {
            type: "application/pdf",
          }),
        ],
      },
    });

    expect(onError).toHaveBeenCalledWith({
      code: "max_file_size",
      message: "All files exceed the maximum size.",
    });
    expect(screen.getByLabelText("Attachment count")).toHaveTextContent("0");
  });

  it("keeps the selected attachment available when FileReader fails", async () => {
    stubAttachmentObjectUrls();
    const readSpy = vi
      .spyOn(FileReader.prototype, "readAsDataURL")
      .mockImplementation(function (this: FileReader) {
        this.onerror?.(new ProgressEvent("error") as ProgressEvent<FileReader>);
      });
    const onSubmit = vi.fn();

    render(
      <PromptInputProvider>
        <PromptInput onSubmit={onSubmit}>
          <AttachmentCount />
          <button type="submit">Send</button>
        </PromptInput>
      </PromptInputProvider>,
    );

    fireEvent.change(screen.getByLabelText("Upload files"), {
      target: {
        files: [
          new File(["synthetic pdf"], "review.pdf", {
            type: "application/pdf",
          }),
        ],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(readSpy).toHaveBeenCalledOnce());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Attachment count")).toHaveTextContent("1");
  });
});
