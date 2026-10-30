import * as React from "react";
import { cn } from "@/lib/utils/cn";

const Separator = React.forwardRef<HTMLHRElement, React.HTMLAttributes<HTMLHRElement>>(
  ({ className, ...props }, ref) => {
    return (
      <hr
        className={cn("shrink-0 border-border", className)}
        ref={ref}
        {...props}
      />
    );
  },
);
Separator.displayName = "Separator";

export { Separator };