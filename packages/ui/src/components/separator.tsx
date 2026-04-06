"use client"

import * as React from "react"
import { cn } from "../lib/utils"

function Separator({
  className,
  orientation = "horizontal",
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  orientation?: "horizontal" | "vertical"
}) {
  return (
    <div
      role="separator"
      data-slot="separator"
      data-orientation={orientation}
      className={cn(
        "shrink-0 bg-border",
        orientation === "horizontal" ? "h-px w-full" : "w-px self-stretch",
        className
      )}
      {...props}
    />
  )
}

export { Separator }
