import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from './ui';
import { ChevronDown, CircleAlert, Plus, RefreshCw } from 'lucide-react';
import { errorSupportReferences } from './error-support';

/**
 * What a stakeholder sees when a route throws.
 *
 * React Router mounts its own error boundary per route, and it catches before any
 * boundary an ancestor component could provide, so the app's `ErrorBoundary` in
 * main.tsx never ran for a render error inside a page, and the fallback on screen
 * was the router's development page, headed "Hey developer" and printing a stack
 * trace. This is the audience-appropriate replacement.
 */
export function RouteError() {
  const error = useRouteError();

  const detail = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'No further detail was reported.';
  const stack = error instanceof Error ? error.stack : undefined;
  const references = errorSupportReferences(error);

  return (
    <div className="page-shell">
      <Card>
        <CardHeader>
          <CardTitle className="text-destructive flex items-center gap-2">
            <CircleAlert className="size-5" /> This view could not be displayed
          </CardTitle>
          <CardDescription>
            Something in this panel failed to draw. Nothing you did caused it, and no data has been changed or lost.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <Alert>
            <AlertDescription>
              The rest of the application is still working. Use the navigation above to move to another view, or reload
              to try this one again.
            </AlertDescription>
          </Alert>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => window.location.reload()}>
              <RefreshCw /> Reload this view
            </Button>
            <Button variant="outline" asChild>
              <Link to="/">
                <Plus /> Go to Ask
              </Link>
            </Button>
          </div>
          {references.length > 0 ? (
            <Alert>
              <AlertDescription>
                {references.map((reference) => (
                  <p className="font-mono text-xs" key={reference.label}>
                    {reference.label}: {reference.value}
                  </p>
                ))}
              </AlertDescription>
            </Alert>
          ) : null}
          {import.meta.env.DEV ? (
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm">
                  Technical detail <ChevronDown />
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-3">
                <div className="code-panel">
                  <pre>{stack ? `${detail}\n\n${stack}` : detail}</pre>
                </div>
              </CollapsibleContent>
            </Collapsible>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
