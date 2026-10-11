/**
 * Guide artwork for the workbench tab: the Host's guide draws an entry's icon
 * as a component (`ComponentType<IconProps>`) and falls back to its own cube
 * placeholder when a type offers none — an object here would break rendering.
 */

/** The props the guide passes an entry's icon. */
export interface ArtworkProps {
  size?: number | undefined
  className?: string | undefined
}

/**
 * The workbench: a clapperboard over a frame.
 * @param props - icon size and layout class from the Host.
 * @returns the artwork.
 */
export function ArtworkStudio({ size = 36, className }: ArtworkProps) {
  return (
    <svg width={size} height={size} className={className} aria-hidden="true" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="6.5" y="13" width="23" height="15" rx="2.5" stroke="#F28B5B" strokeWidth="2" />
      <path d="M6.5 18.5H29.5" stroke="#F8B48F" strokeWidth="2" />
      <path d="M9 13L11.5 7.5H15.5L13 13M16.5 13L19 7.5H23L20.5 13" stroke="#F28B5B" strokeWidth="2" strokeLinejoin="round" />
      <path d="M13 23.5L18.5 26.5L13 29.5V23.5Z" fill="#F8B48F" />
    </svg>
  )
}
