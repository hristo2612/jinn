"use client"

import { cn } from "@/lib/utils"

interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  width?: number | string
  height?: number | string
}

function Skeleton({ className, width, height, style, ...props }: SkeletonProps) {
  return (
    <div
      className={cn(
        "animate-shimmer rounded-md",
        className
      )}
      style={{
        background: `linear-gradient(90deg, var(--fill-secondary) 25%, var(--fill-tertiary) 50%, var(--fill-secondary) 75%)`,
        backgroundSize: '200% 100%',
        width,
        height,
        ...style,
      }}
      {...props}
    />
  )
}

export { Skeleton }
