/**
 * Kiln and Ember logos as icon components. They take the same props as Lucide icons
 * (className, color via currentColor), so they can sit anywhere a LucideIcon does.
 * Full-color marks live in public/brand/.
 */
import type { LucideIcon, LucideProps } from "lucide-react";
import { forwardRef, useId } from "react";

type SvgProps = Omit<LucideProps, "ref">;

function clean(props: SvgProps) {
  // Lucide-only props that make no sense on a filled logo.
  const rest: Record<string, unknown> = { ...props };
  delete rest.strokeWidth;
  delete rest.absoluteStrokeWidth;
  delete rest.size;
  return { ...rest, ...(props.size !== undefined ? { width: props.size, height: props.size } : {}) };
}

export const KilnGlyph = forwardRef<SVGSVGElement, SvgProps>(function KilnGlyph(props, ref) {
  return (
    <svg
      ref={ref}
      viewBox="6 5 52 52"
      width={24}
      height={24}
      fill="currentColor"
      aria-hidden
      {...clean(props)}
    >
      <path
        fillRule="evenodd"
        d="M29.6 7.5h4.8a1.6 1.6 0 0 1 1.6 1.6v2.5C44.5 13.4 50 20.8 50 29.6V47H14V29.6c0-8.8 5.5-16.2 14-18V9.1a1.6 1.6 0 0 1 1.6-1.6z M24.5 47V37.6a7.5 7.5 0 0 1 15 0V47z"
      />
      <circle cx="32" cy="42.2" r="4.3" />
      <rect x="9.5" y="47" width="45" height="4.4" rx="2.2" />
    </svg>
  );
}) as unknown as LucideIcon;

export const EmberGlyph = forwardRef<SVGSVGElement, SvgProps>(function EmberGlyph(props, ref) {
  const id = useId();
  return (
    <svg
      ref={ref}
      viewBox="9 6 46 46"
      width={24}
      height={24}
      fill="currentColor"
      aria-hidden
      {...clean(props)}
    >
      <defs>
        <mask id={id}>
          <rect width="64" height="64" fill="#fff" />
          <ellipse cx="25.5" cy="21.5" rx="5.6" ry="3.4" transform="rotate(-32 25.5 21.5)" fill="#000" />
        </mask>
      </defs>
      <path
        mask={`url(#${id})`}
        d="M33.7 9.5c9.5.2 17.5 6.5 18.3 16.5.9 10.3-4.3 20-14 23.3-10.3 3.5-22-.8-25.3-11-3.4-10.5 1-22.8 10-26.8 3.5-1.5 7.3-2.1 11-2z"
      />
    </svg>
  );
}) as unknown as LucideIcon;
