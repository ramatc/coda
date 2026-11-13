// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Button, buttonVariants } from "../src/components/button";
import { cn } from "../src/lib/cn";

afterEach(() => {
  cleanup();
});

const VARIANTS = ["primary", "secondary", "tertiary", "destructive"] as const;

describe("Button", () => {
  it("defaults to primary, control radius, visible focus and type=button", () => {
    render(<Button>Save</Button>);

    const button = screen.getByRole("button", { name: "Save" });
    expect(button.className).toContain("bg-coda-solid");
    expect(button.className).toContain("rounded-control");
    expect(button.className).toContain("focus-ring");
    expect(button.getAttribute("type")).toBe("button");
  });

  it.each([
    ["primary", "bg-coda-solid"],
    ["secondary", "border-border-strong"],
    ["tertiary", "text-text-secondary"],
    ["destructive", "bg-danger-solid"],
  ] as const)("%s variant uses its token", (variant, token) => {
    expect(buttonVariants({ variant })).toContain(token);
  });

  it("never uses glow, gradients or shadows", () => {
    for (const variant of VARIANTS) {
      expect(buttonVariants({ variant })).not.toMatch(/shadow|gradient|blur/);
    }
  });

  it("does not fire onClick when disabled", () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Save
      </Button>,
    );

    fireEvent.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("cn", () => {
  it("keeps a type-scale size and a text color together", () => {
    expect(cn("text-body", "text-text-primary")).toBe(
      "text-body text-text-primary",
    );
  });

  it("lets a later radius token override an earlier one", () => {
    expect(cn("rounded-control", "rounded-panel")).toBe("rounded-panel");
  });
});
