import { describe, expect, it } from "vitest";
import { findPersonForMailSender } from "./people";
import type { PersonDto } from "@/lib/hooks/use-people";

function person(overrides: Partial<PersonDto> = {}): PersonDto {
  return {
    id: "alex-rivera",
    path: "people/alex-rivera.md",
    name: "Alex Rivera",
    initials: "AR",
    role: "",
    company: "",
    email: "alex@example.com",
    relationship: "",
    favorite: false,
    body: "",
    ...overrides,
  };
}

describe("findPersonForMailSender", () => {
  it("prefers explicit mention ids", () => {
    const match = findPersonForMailSender(
      [person(), person({ id: "sam-chen", name: "Sam Chen", email: "sam@example.com" })],
      { fromEmail: "unknown@example.com", mentions: ["sam-chen"] },
    );

    expect(match?.name).toBe("Sam Chen");
  });

  it("falls back to sender email", () => {
    const match = findPersonForMailSender(
      [person()],
      { fromEmail: "ALEX@example.com", mentions: [] },
    );

    expect(match?.id).toBe("alex-rivera");
  });
});
