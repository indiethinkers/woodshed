import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "./markdown";

describe("Markdown", () => {
  it("preserves intentional soft line breaks for plain-text agent lists", () => {
    const { container } = render(
      <Markdown
        preserveSoftBreaks
        text={[
          "A cleaner portfolio might be:",
          "",
          "Tech Twitter: distribution and editorial surface",
          "Woodshed: builder credibility and personal AI software lab",
          "Indie Thinkers: long-term intellectual/media brand",
        ].join("\n")}
      />,
    );

    const paragraphs = container.querySelectorAll("p");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[1]?.querySelectorAll("br")).toHaveLength(2);
    expect(paragraphs[1]).toHaveTextContent(
      "Tech Twitter: distribution and editorial surfaceWoodshed: builder credibility and personal AI software labIndie Thinkers: long-term intellectual/media brand",
    );
  });

  it("keeps normal Markdown soft-wrap behavior by default", () => {
    const { container } = render(<Markdown text={"One line\ncontinues here"} />);

    expect(container.querySelector("p")).toHaveTextContent(
      "One line continues here",
    );
    expect(container.querySelector("br")).not.toBeInTheDocument();
  });
});
