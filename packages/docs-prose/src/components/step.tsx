import { Children, isValidElement, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "../lib/cn";

export interface StepProps {
  children?: ReactNode;
}

export interface StepItemProps {
  title?: string;
  children?: ReactNode;
}

export interface StepFrameProps {
  /** The number drawn in the circle, from 1. */
  number: number;
  /** The last step has no space below it. */
  last: boolean;
  /** Extra attributes for the numbered circle. The editor marks it read-only. */
  markerProps?: HTMLAttributes<HTMLDivElement>;
  children?: ReactNode;
}

/** The column that holds the steps. */
export function StepList({ children }: { children?: ReactNode }) {
  return <div className="flex flex-col">{children}</div>;
}

/**
 * One step's frame: the numbered circle on the line, with the step beside it.
 * `Step` wraps each item in one. The editor draws each step on its own, so it
 * uses the frame directly and passes the number.
 */
export function StepFrame({ number, last, markerProps, children }: StepFrameProps) {
  return (
    <div
      className={cn("relative border-l pl-9", {
        "pb-5": !last,
      })}
    >
      <div
        {...markerProps}
        className="absolute -left-4 flex size-8 items-center justify-center rounded-full border bg-secondary text-xs font-medium"
      >
        {number}
      </div>
      {children}
    </div>
  );
}

export function Step({ children }: StepProps) {
  // Only elements are steps. Whitespace between the items would otherwise take
  // a number of its own.
  const steps = Children.toArray(children).filter(isValidElement);

  return (
    <StepList>
      {steps.map((step, index) => (
        <StepFrame key={index} number={index + 1} last={index === steps.length - 1}>
          {step}
        </StepFrame>
      ))}
    </StepList>
  );
}

export function StepItem({ children, title }: StepItemProps) {
  return (
    <div className="pt-0.5!">
      {title && <h3 className="mt-0!">{title}</h3>}
      <div>{children}</div>
    </div>
  );
}
