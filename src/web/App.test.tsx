import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { App } from "./App";

afterEach(cleanup);

it("renders the Heed placeholder page", () => {
  render(<App />);

  expect(screen.getByRole("heading", { name: "Heed" })).toBeTruthy();
  expect(
    screen.getByText("A workspace for human and agent work."),
  ).toBeTruthy();
});
