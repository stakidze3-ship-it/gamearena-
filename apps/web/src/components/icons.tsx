/** Minimal 1.75px stroke icon set — quiet, consistent, slightly friendly. */
import * as React from "react";

function Icon({
  children,
  className,
  ...props
}: React.SVGProps<SVGSVGElement> & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? "h-5 w-5"}
      aria-hidden
      {...props}
    >
      {children}
    </svg>
  );
}

export const IconPlay = (p: React.SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="3" y="3" width="7.5" height="7.5" rx="1.5" />
    <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" />
    <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" />
    <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" />
  </Icon>
);

export const IconBolt = (p: React.SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M13 2 4.5 13.5h6L11 22l8.5-11.5h-6L13 2z" />
  </Icon>
);

export const IconTrophy = (p: React.SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M8 21h8M12 17v4M7 4h10v6a5 5 0 0 1-10 0V4z" />
    <path d="M7 6H4a2 2 0 0 0 2 4h1M17 6h3a2 2 0 0 1-2 4h-1" />
  </Icon>
);

export const IconWallet = (p: React.SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="3" y="6" width="18" height="13" rx="2.5" />
    <path d="M3 9.5h18M16.5 14.5h.01" />
  </Icon>
);

export const IconUser = (p: React.SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="12" cy="8.5" r="3.75" />
    <path d="M5 20a7.5 7.5 0 0 1 14 0" />
  </Icon>
);

export const IconShield = (p: React.SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M12 3 5 5.8v5.4c0 4.3 2.9 7.4 7 8.8 4.1-1.4 7-4.5 7-8.8V5.8L12 3z" />
    <path d="m9.2 11.8 2 2 3.6-3.9" />
  </Icon>
);

export const IconChart = (p: React.SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M4 20V4M4 20h16" />
    <path d="M8.5 15.5v-4M13 15.5V8M17.5 15.5v-6.5" />
  </Icon>
);

export const IconLogout = (p: React.SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M14 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2" />
    <path d="M9 12h11m0 0-3.25-3.25M20 12l-3.25 3.25" />
  </Icon>
);

export const IconVault = (p: React.SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="3" y="6" width="18" height="14" rx="2.5" />
    <path d="M3 10h18M12 6V4M8.5 15.5h.01M15.5 15.5h.01" />
  </Icon>
);

export const IconUsers = (p: React.SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="9" cy="8" r="3.25" />
    <path d="M2.5 19a6.5 6.5 0 0 1 13 0" />
    <path d="M16 5.5a3.25 3.25 0 0 1 0 6.3M17.5 13.2A6.5 6.5 0 0 1 21.5 19" />
  </Icon>
);

export const IconClock = (p: React.SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Icon>
);

export const IconChevronRight = (p: React.SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="m9 5.5 6.5 6.5L9 18.5" />
  </Icon>
);

export const IconChevronLeft = (p: React.SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M15 5.5 8.5 12l6.5 6.5" />
  </Icon>
);

export const IconChevronDown = (p: React.SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="m5.5 9 6.5 6.5L18.5 9" />
  </Icon>
);

export const IconX = (p: React.SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);

export const IconCheck = (p: React.SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="m4.5 12.5 5 5L19.5 7" />
  </Icon>
);

export const IconVolume = (p: React.SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z" />
    <path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11" />
  </Icon>
);

export const IconVolumeOff = (p: React.SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4z" />
    <path d="m15.5 9.5 5 5M20.5 9.5l-5 5" />
  </Icon>
);

export const IconMedal = (p: React.SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="12" cy="14.5" r="5.5" />
    <path d="m12 12.4.8 1.6 1.8.3-1.3 1.2.3 1.8-1.6-.9-1.6.9.3-1.8-1.3-1.2 1.8-.3.8-1.6z" fill="currentColor" stroke="none" />
    <path d="M8.5 10 5.5 3.5M15.5 10l3-6.5M9.5 3.5l1.6 3.6M14.5 3.5l-1 2.3" />
  </Icon>
);

export const IconMore = (p: React.SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="5" cy="12" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="0.9" fill="currentColor" stroke="none" />
  </Icon>
);
