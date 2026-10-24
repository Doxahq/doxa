import type { EditableSiteConfig } from "@doxahq/site-config"

import {
  SegmentedControl,
  SettingsSection,
  Switch,
  TextInput,
} from "~/components/dashboard/content/site-settings/fields/controls"
import { LinkListField } from "~/components/dashboard/content/site-settings/fields/link-list-field"
import { ValidatedField } from "~/components/dashboard/content/site-settings/fields/validated-field"
import { useSiteSettingsContext } from "~/components/dashboard/content/site-settings/site-settings-context"

type Navbar = EditableSiteConfig["navbar"]
type NavbarCta = NonNullable<Navbar["cta"]>

const NAVBAR_LINK_LIMIT = 8
const DEFAULT_CTA: NavbarCta = { label: "Get started", href: "/", newTab: false, variant: "primary" }

export function NavbarTab() {
  const { state } = useSiteSettingsContext()
  const { navbar } = state.config
  const setNavbar = (next: Partial<Navbar>) =>
    state.update((current) => ({ ...current, navbar: { ...current.navbar, ...next } }))
  const setCta = (next: Partial<NavbarCta>) =>
    state.update((current) =>
      current.navbar.cta
        ? { ...current, navbar: { ...current.navbar, cta: { ...current.navbar.cta, ...next } } }
        : current,
    )
  const cta = navbar.cta

  return (
    <div className="space-y-8">
      <SettingsSection
        title="Call to action"
        description="One highlighted button on the right of the navbar."
        actions={
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Switch
              checked={cta !== null}
              onCheckedChange={(enabled) => setNavbar({ cta: enabled ? DEFAULT_CTA : null })}
              aria-label="Show a call to action button"
            />
            Show
          </label>
        }
      >
        {cta ? (
          <div className="grid gap-4 md:grid-cols-2">
            <ValidatedField pointer="/navbar/cta/label" label="Button label">
              {(control) => <TextInput {...control} value={cta.label} onValueChange={(label) => setCta({ label })} />}
            </ValidatedField>
            <ValidatedField pointer="/navbar/cta/href" label="Button link">
              {(control) => (
                <TextInput
                  {...control}
                  value={cta.href}
                  onValueChange={(href) => setCta({ href })}
                  placeholder="/quickstart or https://example.com"
                  className="font-mono text-xs"
                  spellCheck={false}
                />
              )}
            </ValidatedField>
            <ValidatedField pointer="/navbar/cta/variant" label="Style">
              {(control) => (
                <SegmentedControl
                  id={control.id}
                  label="Button style"
                  value={cta.variant}
                  options={[
                    { value: "primary", label: "Filled" },
                    { value: "outline", label: "Outline" },
                  ]}
                  onValueChange={(variant) => setCta({ variant })}
                />
              )}
            </ValidatedField>
            <ValidatedField pointer="/navbar/cta/newTab" label="Opening">
              {(control) => (
                <label className="flex h-9 items-center gap-2 text-sm text-muted-foreground">
                  <Switch id={control.id} checked={cta.newTab} onCheckedChange={(newTab) => setCta({ newTab })} />
                  Open in a new tab
                </label>
              )}
            </ValidatedField>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">The navbar has no call to action button.</p>
        )}
      </SettingsSection>

      <SettingsSection title="Links" description="Extra links next to the navbar sections. Use a path such as /changelog for a docs page.">
        <LinkListField
          pointer="/navbar/links"
          links={navbar.links}
          onChange={(links) => setNavbar({ links })}
          max={NAVBAR_LINK_LIMIT}
          emptyText="No navbar links yet."
        />
      </SettingsSection>

      <SettingsSection title="GitHub">
        <ValidatedField
          pointer="/navbar/github"
          label="Repository link"
          description="Shows a GitHub icon in the navbar. Leave it empty to hide the icon."
        >
          {(control) => (
            <TextInput
              {...control}
              value={navbar.github ?? ""}
              onValueChange={(github) => setNavbar({ github: github.trim() === "" ? null : github })}
              placeholder="https://github.com/acme/app"
              className="font-mono text-xs"
              spellCheck={false}
            />
          )}
        </ValidatedField>
      </SettingsSection>
    </div>
  )
}
