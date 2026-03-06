"use client"

import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--system-blue)]",
  {
    variants: {
      variant: {
        default: "bg-[var(--accent)] text-black font-semibold btn-scale hover:shadow-[0_0_24px_var(--accent-fill)]",
        destructive:
          "bg-[var(--system-red)] text-white btn-scale",
        outline:
          "border border-[var(--separator)] bg-transparent shadow-[var(--shadow-subtle)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]",
        secondary:
          "bg-[var(--accent-fill)] text-[var(--accent)] font-semibold btn-scale",
        ghost:
          "bg-transparent text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)]",
        link: "text-[var(--system-blue)] underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 text-sm has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 rounded-md gap-1.5 px-3 text-sm has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 text-base has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
