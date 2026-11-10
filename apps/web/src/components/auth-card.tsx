import { Alert, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@cb/ui';
import { AlertCircle } from 'lucide-react';
import type { ReactNode } from 'react';

/** Centered card shared by the auth pages. */
export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-sm py-4 sm:py-10">
      <Card>
        <CardHeader>
          <CardTitle>
            <span className="text-2xl">{title}</span>
          </CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
      {footer && <div className="mt-4 text-center text-sm text-muted-foreground">{footer}</div>}
    </div>
  );
}

export function FormError({ message }: { message?: string | undefined }) {
  if (!message) return null;
  return (
    <Alert variant="destructive">
      <AlertCircle aria-hidden />
      <div>{message}</div>
    </Alert>
  );
}
