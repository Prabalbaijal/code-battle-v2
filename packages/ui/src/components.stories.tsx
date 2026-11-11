import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { UserAvatar } from './avatar';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
  Skeleton,
  Spinner,
  Textarea,
} from './components';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';

const meta: Meta = { title: 'UI kit' };
export default meta;
type Story = StoryObj;

const VARIANTS = ['default', 'secondary', 'outline', 'ghost', 'destructive', 'link'] as const;

export const Buttons: Story = {
  render: () => (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-2">
        {VARIANTS.map((v) => (
          <Button key={v} variant={v}>
            {v}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm">Small</Button>
        <Button>Default</Button>
        <Button size="lg">Large</Button>
        <Button loading>Saving</Button>
        <Button disabled>Disabled</Button>
      </div>
    </div>
  ),
};

export const Badges: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      {(['default', 'secondary', 'success', 'warning', 'destructive'] as const).map((v) => (
        <Badge key={v} variant={v}>
          {v}
        </Badge>
      ))}
    </div>
  ),
};

export const Alerts: Story = {
  render: () => (
    <div className="grid max-w-lg gap-3">
      {(['default', 'info', 'success', 'warning', 'destructive'] as const).map((v) => (
        <Alert key={v} variant={v}>
          A {v} alert: what happened and what to do next.
        </Alert>
      ))}
    </div>
  ),
};

export const Forms: Story = {
  render: () => (
    <form className="grid max-w-sm gap-4" onSubmit={(e) => e.preventDefault()}>
      <Field id="u" label="Username" hint="3–20 letters, digits or _.">
        <Input defaultValue="cara_1" />
      </Field>
      <Field id="e" label="Email" error="Enter a valid email">
        <Input defaultValue="nope" />
      </Field>
      <Field id="l" label="Language">
        <Select defaultValue="cpp">
          <option value="cpp">C++</option>
          <option value="python">Python 3</option>
        </Select>
      </Field>
      <Field id="b" label="Bio">
        <Textarea rows={3} defaultValue="Competitive programmer." />
      </Field>
      <Button type="submit">Save</Button>
    </form>
  ),
};

export const Cards: Story = {
  render: () => (
    <Card className="max-w-sm">
      <CardHeader>
        <CardTitle>Pair sums</CardTitle>
        <CardDescription>Easy · 1.0 s · 192 MB</CardDescription>
      </CardHeader>
      <CardContent className="text-sm">Print a + b for each pair.</CardContent>
    </Card>
  ),
};

function TabsDemo() {
  const [v, setV] = useState('global');
  return (
    <Tabs value={v} onValueChange={setV} className="grid max-w-md gap-3">
      <TabsList aria-label="Scope">
        <TabsTrigger value="global">Everyone</TabsTrigger>
        <TabsTrigger value="friends">Friends</TabsTrigger>
      </TabsList>
      <TabsContent value="global">Top 50 players.</TabsContent>
      <TabsContent value="friends">You and your friends.</TabsContent>
    </Tabs>
  );
}
export const TabsStory: Story = { name: 'Tabs', render: () => <TabsDemo /> };

export const Avatars: Story = {
  render: () => (
    <div className="flex items-center gap-3">
      <UserAvatar name="Cara Tester" size="sm" />
      <UserAvatar name="Dev Tester" />
      <UserAvatar name="Ana" size="lg" />
    </div>
  ),
};

export const Loading: Story = {
  render: () => (
    <div className="grid max-w-sm gap-3">
      <Spinner />
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-24" />
    </div>
  ),
};
