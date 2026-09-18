export default function Logo({ className = 'h-7 w-7' }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <circle cx="16" cy="16" r="15" className="fill-leaf-700" />
      <path d="M16 25c0-6 3-10 8-12-1 7-4 10-8 12z" className="fill-leaf-300" />
      <path d="M16 25c0-6-3-10-8-12 1 7 4 10 8 12z" className="fill-leaf-400" />
      <path d="M16 26V15" className="stroke-leaf-100" strokeWidth="1.4" strokeLinecap="round" fill="none" />
      <circle cx="16" cy="9" r="2.2" className="fill-wheat-400" />
    </svg>
  )
}
