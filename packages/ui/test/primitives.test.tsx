// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Artwork } from "../src/components/artwork";
import { Input, Select, Textarea } from "../src/components/field";
import { IndexNumber } from "../src/components/index-number";

afterEach(() => {
  cleanup();
});

describe("IndexNumber", () => {
  it.each([
    [1, "01"],
    [3, "03"],
    [12, "12"],
    [100, "100"],
  ])("renders %i as %s with tabular numerals", (value, text) => {
    render(<IndexNumber value={value} />);

    const el = screen.getByTestId("index-number");
    expect(el.textContent).toBe(text);
    expect(el.className).toContain("tabular-nums");
  });
});

describe("Artwork", () => {
  it("renders a square, artwork-radius frame with a covering image and alt", () => {
    render(<Artwork src="/a.jpg" alt="OK Computer" className="w-16" />);

    const frame = screen.getByTestId("artwork");
    expect(frame.className).toContain("aspect-square");
    expect(frame.className).toContain("rounded-artwork");
    expect(frame.className).not.toMatch(/shadow/);
    expect(screen.getByAltText("OK Computer").className).toContain(
      "object-cover",
    );
  });
});

describe("form controls", () => {
  it("marks invalid fields with aria-invalid and the danger border", () => {
    render(
      <>
        <Input aria-label="name" invalid />
        <Textarea aria-label="body" invalid />
        <Select aria-label="kind" invalid>
          <option>a</option>
        </Select>
      </>,
    );

    for (const name of ["name", "body", "kind"]) {
      const el = screen.getByLabelText(name);
      expect(el.getAttribute("aria-invalid")).toBe("true");
      expect(el.className).toContain("aria-invalid:border-danger");
      expect(el.className).toContain("rounded-control");
      expect(el.className).toContain("placeholder:text-text-tertiary");
    }
  });

  it("omits aria-invalid when valid and supports disabled", () => {
    render(<Input aria-label="name" disabled />);

    const el = screen.getByLabelText("name") as HTMLInputElement;
    expect(el.hasAttribute("aria-invalid")).toBe(false);
    expect(el.disabled).toBe(true);
  });
});
