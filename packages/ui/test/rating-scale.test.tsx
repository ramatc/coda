// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RatingScale } from "../src/components/rating-scale";

afterEach(() => {
  cleanup();
});

describe("RatingScale", () => {
  it("renders ten segments regardless of value", () => {
    render(<RatingScale value={9.1} />);

    expect(screen.getAllByTestId("rating-scale-segment")).toHaveLength(10);
  });

  it("fully fills every segment below the integer part and partially fills the next one", () => {
    render(<RatingScale value={9.1} />);

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
    render(<RatingScale value={15} />);

    expect(screen.getByTestId("rating-scale-value").textContent).toBe(
      "10.0",
    );
  });

  it("rounds to the nearest 0.1", () => {
    render(<RatingScale value={7.28} />);

    expect(screen.getByTestId("rating-scale-value").textContent).toBe("7.3");
  });

  it("shows the numeric value by default, one decimal place", () => {
    render(<RatingScale value={8.8} />);

    expect(screen.getByTestId("rating-scale-value").textContent).toBe("8.8");
  });

  it("hides the numeric value when showValue is false", () => {
    render(<RatingScale value={8.8} showValue={false} />);

    expect(screen.queryByTestId("rating-scale-value")).toBeNull();
  });

  it("exposes the rating as an accessible label", () => {
    render(<RatingScale value={9.1} />);

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

    const buttons = screen.getAllByTestId("rating-scale-segment");
    fireEvent.click(buttons[6]);

    expect(onChange).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("interactive: click always reports a whole number regardless of the underlying value's decimal precision", () => {
    const onChange = vi.fn();
    render(<RatingScale value={7.4} interactive onChange={onChange} />);

    const buttons = screen.getAllByTestId("rating-scale-segment");
    fireEvent.click(buttons[2]);

    expect(onChange).toHaveBeenCalledExactlyOnceWith(3);
  });

  it("interactive: renders real, independently labeled buttons instead of decorative spans", () => {
    const onChange = vi.fn();
    render(<RatingScale value={4} interactive onChange={onChange} />);

    const buttons = screen.getAllByTestId("rating-scale-segment");
    expect(buttons).toHaveLength(10);
    expect(buttons.every((button) => button.tagName === "BUTTON")).toBe(true);
    expect(screen.getByLabelText("Rate 7 out of 10")).not.toBeNull();
  });

  it("interactive: hovering a segment previews its fill, and mouse-leave reverts it", () => {
    const onChange = vi.fn();
    render(<RatingScale value={3} interactive onChange={onChange} />);

    const buttons = screen.getAllByTestId("rating-scale-segment");
    const fillWidth = (index: number) =>
      (buttons[index].firstElementChild as HTMLElement).style.width;

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

    const buttons = screen.getAllByTestId("rating-scale-segment");
    const fillWidth = (index: number) =>
      (buttons[index].firstElementChild as HTMLElement).style.width;

    fireEvent.focus(buttons[4]);
    expect(fillWidth(4)).toBe("100%");

    fireEvent.blur(buttons[4]);
    expect(fillWidth(4)).toBe("0%");
    expect(fillWidth(0)).toBe("100%");
  });

  it("interactive + disabled: blocks click and hover preview, but keeps displaying the current value", () => {
    const onChange = vi.fn();
    render(<RatingScale value={5} interactive disabled onChange={onChange} />);

    const buttons = screen.getAllByTestId("rating-scale-segment");
    const fillWidth = (index: number) =>
      (buttons[index].firstElementChild as HTMLElement).style.width;

    fireEvent.click(buttons[8]);
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.mouseEnter(buttons[8]);
    expect(fillWidth(8)).toBe("0%");

    // The current value (5) is still shown normally.
    expect(fillWidth(4)).toBe("100%");
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(true);
    expect(buttons[0].getAttribute("aria-disabled")).toBe("true");
  });
});
