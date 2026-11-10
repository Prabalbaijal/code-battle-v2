import { Button, Card } from '@cb/ui';
import { Coins, Swords, Timer, Users } from 'lucide-react';
import Link from 'next/link';

/** Landing (SSG, plan §21.2). */
export default function HomePage() {
  return (
    <div className="grid gap-16 py-6 sm:py-12">
      <section className="grid gap-6 text-center">
        <p className="mx-auto inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
          <span className="size-1.5 rounded-full bg-success" aria-hidden /> 1v1 · real time · same problem
        </p>
        <h1 className="mx-auto max-w-2xl text-balance text-4xl font-bold tracking-tight sm:text-6xl">
          Out-code your friends. <span className="text-primary">Live.</span>
        </h1>
        <p className="mx-auto max-w-xl text-balance text-lg text-muted-foreground">
          Challenge a friend, get the same problem, and race to the first accepted solution. The server judges
          every submission, so the fastest correct coder wins.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <Button asChild size="lg">
            <Link href="/register">Create an account</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/login">Log in</Link>
          </Button>
        </div>
      </section>

      <section aria-label="How it works" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { icon: Users, title: 'Add friends', text: 'Find players by username and send a request.' },
          {
            icon: Swords,
            title: 'Challenge',
            text: 'Pick a difficulty. You both get a problem neither has seen.',
          },
          {
            icon: Timer,
            title: 'Race the clock',
            text: 'Earliest accepted submission wins, judged on the server.',
          },
          { icon: Coins, title: 'Win coins', text: 'Climb levels and the leaderboard with every victory.' },
        ].map(({ icon: Icon, title, text }) => (
          <Card key={title} className="p-5">
            <Icon className="mb-3 size-5 text-primary" aria-hidden />
            <h2 className="font-semibold">{title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{text}</p>
          </Card>
        ))}
      </section>
    </div>
  );
}
