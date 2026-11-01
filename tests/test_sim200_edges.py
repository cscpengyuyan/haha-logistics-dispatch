"""T39/T42 real business service replay and interruption-safe reuse."""
from pathlib import Path
from tempfile import TemporaryDirectory
import sys,unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from verify_sim200_edges import verify

class EdgeCases(unittest.TestCase):
    def test_replenishment_receipt_shortage_replacement_and_replay(self):
        with TemporaryDirectory(prefix='sim200-edge-test-') as tmp:
            first=verify(Path(tmp));second=verify(Path(tmp))
            self.assertEqual(first['trace_events'],59)
            self.assertEqual(first,second)
            self.assertEqual(first['inventory'],{'available':3,'delivered':2})
            self.assertEqual(first['T42']['final_order_state'],'settled')
            self.assertEqual(first['T39']['remaining_replenishment'],0)

if __name__=='__main__':unittest.main()
