// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  RatingScale,
  RatingScaleDisplay,
  RatingScaleInteractive,
} from "../src/components/rating-scale";

afterEach(() => {
  cleanup();
});

describe("RatingScale", () => {
  it("renders ten segments regardless of value", () => {
    render(<RatingScale value={9.1} />);

    expect(screen.getAllByTestId("rating-scale-segment")).toHaveLength(10);
  });

  it("aggregate: fully fills every segment below the integer part and partially fills the next one", () => {
    render(<RatingScale value={9.1} variant="aggregate" />);

    const segments = screen.getAllByTestId("rating-scale-segment");
    // Segments 0–8 (nine of them) are fully filled; segment 9 is 10% filled.
    const fills = segments.map(
      (segment) => (segment.firstElementChild as HTMLElement).style.width,
    );

    expect(fills.slice(0, 9)).toEqual(Array(9).fill("100%"));
    expect(fills[9]).toBe("10%");
  });

  it("fills exactly one segment for the minimum value (1 is not nothing)", () => {
    render(<RatingScale value={1} />);

    const segments = screen.getAllByTestId("rating-scale-segment");
    const fills = segments.map(
      (segment) => (segment.firstElementChild as HTMLElement).style.width,
    );

    expect(fills[0]).toBe("100%");
    expect(fills[1]).toBe("0%");
    expect(fills[9]).toBe("0%");
  });

  it("fills every segment for the maximum value", () => {
    render(<RatingScale value={10} />);

    const segments = screen.getAllByTestId("rating-scale-segment");
    const fills = segments.map(
      (segment) => (segment.firstElementChild as HTMLElement).style.width,
    );

    expect(fills).toEqual(Array(10).fill("100%"));
  });

  it("clamps an out-of-range value into 1.0–10.0", () => {
    render(<RatingScale value={15} variant="aggregate" />);

    expect(screen.getByTestId("rating-scale-value").textContent).toBe("10.0");
  });

  it("aggregate: rounds to the nearest 0.1", () => {
    render(<RatingScale value={7.28} variant="aggregate" />);

    expect(screen.getByTestId("rating-scale-value").textContent).toBe("7.3");
  });

  it("aggregate: shows the numeric value with one decimal place", () => {
    render(<RatingScale value={8.8} variant="aggregate" />);

    expect(screen.getByTestId("rating-scale-value").textContent).toBe("8.8");
  });

  it("hides the numeric value when showValue is false", () => {
    render(<RatingScale value={8.8} showValue={false} />);

    expect(screen.queryByTestId("rating-scale-value")).toBeNull();
  });

  it("exposes the rating as an accessible label", () => {
    render(<RatingScale value={9.1} variant="aggregate" />);

    expect(screen.getByLabelText("Rating 9.1 out of 10")).not.toBeNull();
  });

  it("renders all segments empty and a neutral placeholder when value is null, without crashing", () => {
    render(<RatingScale value={null} />);

    const segments = screen.getAllByTestId("rating-scale-segment");
    const fills = segments.map(
      (segment) => (segment.firstElementChild as HTMLElement).style.width,
    );

    expect(fills).toEqual(Array(10).fill("0%"));
    expect(screen.getByTestId("rating-scale-value").textContent).toBe("–");
    expect(screen.getByLabelText("Not rated")).not.toBeNull();
  });

  it("interactive: clicking segment i calls onChange with i + 1", () => {
    const onChange = vi.fn();
    render(<RatingScale value={null} interactive onChange={onChange} />);

    const buttons = screen.getAllByTestId("rating-scale-option");
    fireEvent.click(buttons[6]);

    expect(onChange).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("interactive: click always reports a whole number regardless of the underlying value's decimal precision", () => {
    const onChange = vi.fn();
    render(<RatingScale value={7.4} interactive onChange={onChange} />);

    const buttons = screen.getAllByTestId("rating-scale-option");
    fireEvent.click(buttons[2]);

    expect(onChange).toHaveBeenCalledExactlyOnceWith(3);
  });

  it("interactive: renders real, independently labeled buttons instead of decorative spans", () => {
    const onChange = vi.fn();
    render(<RatingScale value={4} interactive onChange={onChange} />);

    const buttons = screen.getAllByTestId("rating-scale-option");
    expect(buttons).toHaveLength(10);
    expect(buttons.every((button) => button.tagName === "BUTTON")).toBe(true);
    expect(screen.getByLabelText("Rate 7 out of 10")).not.toBeNull();
  });

  it("interactive: hovering a segment previews its fill, and mouse-leave reverts it", () => {
    const onChange = vi.fn();
    render(<RatingScale value={3} interactive onChange={onChange} />);

    const buttons = screen.getAllByTestId("rating-scale-option");
    const fillWidth = (index: number) =>
      (buttons[index].firstElementChild!.firstElementChild as HTMLElement).style
        .width;

    // Baseline: value=3 fills segments 0-2.
    expect(fillWidth(2)).toBe("100%");
    expect(fillWidth(6)).toBe("0%");

    // Hovering segment index 6 (score 7) previews fill through segment 6.
    fireEvent.mouseEnter(buttons[6]);
    expect(fillWidth(6)).toBe("100%");
    expect(fillWidth(7)).toBe("0%");

    // Leaving reverts to the real value.
    fireEvent.mouseLeave(buttons[6]);
    expect(fillWidth(6)).toBe("0%");
    expect(fillWidth(2)).toBe("100%");
  });

  it("interactive: focusing a segment previews its fill, and blur reverts it", () => {
    const onChange = vi.fn();
    render(<RatingScale value={1} interactive onChange={onChange} />);

    const buttons = screen.getAllByTestId("rating-scale-option");
    const fillWidth = (index: number) =>
      (buttons[index].firstElementChild!.firstElementChild as HTMLElement).style
        .width;

    fireEvent.focus(buttons[4]);
    expect(fillWidth(4)).toBe("100%");

    fireEvent.blur(buttons[4]);
    expect(fillWidth(4)).toBe("0%");
    expect(fillWidth(0)).toBe("100%");
  });

  it("interactive + disabled: blocks click and hover preview, but keeps displaying the current value", () => {
    const onChange = vi.fn();
    render(<RatingScale value={5} interactive disabled onChange={onChange} />);

    const buttons = screen.getAllByTestId("rating-scale-option");
    const fillWidth = (index: number) =>
      (buttons[index].firstElementChild!.firstElementChild as HTMLElement).style
        .width;

    fireEvent.click(buttons[8]);
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.mouseEnter(buttons[8]);
    expect(fillWidth(8)).toBe("0%");

    // The current value (5) is still shown normally.
    expect(fillWidth(4)).toBe("100%");
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("radiogroup").getAttribute("aria-disabled")).toBe(
      "true",
    );
  });

  it("personal: shows a whole number (9, not 9.0)", () => {
    render(<RatingScale value={9} variant="personal" />);

    expect(screen.getByTestId("rating-scale-value").textContent).toBe("9");
    expect(screen.getByLabelText("Rating 9 out of 10")).not.toBeNull();
  });

  it("other: rounds a decimal to a whole number and fills whole segments only", () => {
    render(<RatingScale value={8.6} variant="other" />);

    const fills = screen
      .getAllByTestId("rating-scale-segment")
      .map((segment) => (segment.firstElementChild as HTMLElement).style.width);

    expect(screen.getByTestId("rating-scale-value").textContent).toBe("9");
    expect(fills.filter((fill) => fill !== "100%" && fill !== "0%")).toEqual(
      [],
    );
    expect(fills[8]).toBe("100%");
  });

  it("aggregate: shows a community decimal like 8.4", () => {
    render(<RatingScaleDisplay value={8.4} variant="aggregate" />);

    expect(screen.getByTestId("rating-scale-value").textContent).toBe("8.4");
  });

  it("interactive: is a radiogroup with one tab stop and the selected option checked", () => {
    render(<RatingScaleInteractive value={6} onChange={vi.fn()} />);

    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(10);
    expect(radios.filter((r) => r.tabIndex === 0)).toEqual([radios[5]]);
    expect(radios[5].getAttribute("aria-checked")).toBe("true");
    expect(radios[4].getAttribute("aria-checked")).toBe("false");
    // The selected state is also a shape change, not only color.
    expect(radios[5].querySelector("[data-selected]")).not.toBeNull();
  });

  it("interactive: each option is a 24x24px hit area around its visual segment", () => {
    render(<RatingScaleInteractive value={null} onChange={vi.fn()} />);

    const option = screen.getAllByRole("radio")[0];
    expect(option.className).toContain("h-6");
    expect(option.className).toContain("w-6");
    expect(option.firstElementChild?.getAttribute("data-testid")).toBe(
      "rating-scale-segment",
    );
  });

  it("interactive: arrows, Home and End move focus without committing; click/Enter commits", () => {
    const onChange = vi.fn();
    render(<RatingScaleInteractive value={5} onChange={onChange} />);

    const radios = screen.getAllByRole("radio");
    radios[4].focus();

    fireEvent.keyDown(radios[4], { key: "ArrowRight" });
    expect(document.activeElement).toBe(radios[5]);
    fireEvent.keyDown(radios[5], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(radios[4]);
    fireEvent.keyDown(radios[4], { key: "End" });
    expect(document.activeElement).toBe(radios[9]);
    fireEvent.keyDown(radios[9], { key: "ArrowRight" });
    expect(document.activeElement).toBe(radios[9]);
    fireEvent.keyDown(radios[9], { key: "Home" });
    expect(document.activeElement).toBe(radios[0]);
    expect(onChange).not.toHaveBeenCalled();

    // Enter/Space on a native button activates it as a click.
    fireEvent.click(radios[0]);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("interactive: shows the value as a whole number", () => {
    render(<RatingScaleInteractive value={7.4} onChange={vi.fn()} />);

    expect(screen.getByTestId("rating-scale-value").textContent).toBe("7");
  });
});
