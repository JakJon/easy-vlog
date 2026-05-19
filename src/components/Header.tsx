import { AnimatedTagline } from './AnimatedTagline'

export function Header() {
  return (
    <header className="text-center mb-12">
      <h1 className="text-6xl sm:text-7xl tracking-tight">
        <span className="font-display italic text-emerald-500">Easy</span>{' '}
        <span className="font-sans font-bold text-neutral-900">Vlog</span>
      </h1>
      <AnimatedTagline />
      <p className="mt-5 text-sm text-neutral-500 font-sans">
        Upload as many of your photos and videos as you like, we'll stitch them together in the order they were taken to create your vlog for you.
      </p>
    </header>
  )
}
