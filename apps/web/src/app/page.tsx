'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { api, type TestListItem, ApiError } from '../lib/api';
import { formatDuration, formatRelative, statusColor } from '../lib/format';

export default function TestListPage() {
  const [items, setItems] = useState<TestListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.listTests(50, 0);
      setItems(res.tests);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message} (HTTP ${err.status})` : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll only while there's an active test so a running row flips to a
  // terminal status without a manual refresh. 3s feels live enough without
  // spamming the controller during idle periods.
  const hasActive = items?.some((t) => t.status === 'running' || t.status === 'queued') ?? false;
  useEffect(() => {
    if (!hasActive) return;
    const id = setInterval(() => {
      void load();
    }, 3000);
    return () => clearInterval(id);
  }, [hasActive, load]);

  return (
    <Stack spacing={3}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <Typography variant="h1">Tests</Typography>
        <Box sx={{ flex: 1 }} />
        <Tooltip title="Refresh">
          <IconButton onClick={load} disabled={loading}>
            <RefreshIcon />
          </IconButton>
        </Tooltip>
        <Button component={Link} href="/tests/new" variant="contained">
          New test
        </Button>
      </Box>

      {error && <Alert severity="error">{error}</Alert>}

      <Paper variant="outlined">
        {items === null ? (
          <Box sx={{ p: 6, display: 'flex', justifyContent: 'center' }}>
            <CircularProgress />
          </Box>
        ) : items.length === 0 ? (
          <Box sx={{ p: 6, textAlign: 'center' }}>
            <Typography color="text.secondary">No tests yet.</Typography>
            <Button component={Link} href="/tests/new" variant="outlined" sx={{ mt: 2 }}>
              Run your first test
            </Button>
          </Box>
        ) : (
          <TableContainer>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>Name</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Created</TableCell>
                  <TableCell>Duration</TableCell>
                  <TableCell width={48} />
                </TableRow>
              </TableHead>
              <TableBody>
                {items.map((t) => {
                  const dur =
                    t.startedAt && t.endedAt
                      ? t.endedAt - t.startedAt
                      : t.startedAt && t.status === 'running'
                        ? Date.now() - t.startedAt
                        : null;
                  return (
                    <TableRow
                      key={t.id}
                      hover
                      component={Link}
                      href={`/results/${t.id}`}
                      sx={{ textDecoration: 'none', cursor: 'pointer' }}
                    >
                      <TableCell sx={{ color: 'text.primary' }}>
                        <Typography sx={{ fontWeight: 500 }}>{t.name}</Typography>
                        <Typography variant="body2" color="text.secondary" sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                          {t.id}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Chip label={t.status} color={statusColor(t.status)} size="small" variant="outlined" />
                      </TableCell>
                      <TableCell sx={{ color: 'text.secondary' }}>{formatRelative(t.createdAt)}</TableCell>
                      <TableCell sx={{ color: 'text.secondary' }}>{formatDuration(dur)}</TableCell>
                      <TableCell>
                        <OpenInNewIcon fontSize="small" sx={{ color: 'text.secondary' }} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Paper>
    </Stack>
  );
}
