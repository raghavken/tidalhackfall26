`timescale 1ns/1ps
module tb_faults;
reg clk=0,reset_n=0,rx=1,iv=0,mode=0;
reg [7:0] data=0;
always #5 clk=~clk;
wire tx; wire [5:0] red; wire [7:0] green;
reg [7:0] bytes[0:58799];
integer i,j;
top #(.CLOCK_HZ(1600000),.BAUD(100000)) dut(clk,reset_n,mode,rx,tx,red,green);
task reset;
 begin
  @(negedge clk); reset_n=0; iv=0; rx=1;
  repeat(5) @(negedge clk); reset_n=1; repeat(16) @(negedge clk);
  if(red!==0) $fatal(1,"FAIL top reset state");
 end
endtask
task byte_in;
 input [7:0] b;
 begin @(negedge clk); data=b; iv=1; @(negedge clk); iv=0; end
endtask
task fault_check;
 begin
  repeat(8) @(negedge clk);
  if(!red[4] || red[5] || red[3:0] || dut.formatter.tx_valid)
   $fatal(1,"FAIL latched invalidation %h",red);
 end
endtask
initial begin
 $readmemh("build/grid_oscillation.hex",bytes);
 force dut.rx_data=data; force dut.rx_valid=iv;
 reset;
 // A complete window is published before introducing an ordering fault.
 for(i=0;i<16800;i=i+1) byte_in(bytes[i]);
 repeat(10) @(negedge clk);
 if(!red[5] || red[4]) $fatal(1,"FAIL pre-fault window");
 // Missing/duplicate index: restarting at zero is forbidden without reset.
 for(i=0;i<7;i=i+1) byte_in(bytes[i]);
 fault_check;
 for(i=0;i<28;i=i+1) byte_in(bytes[i]); fault_check;
 reset;
 for(i=0;i<6;i=i+1) byte_in(bytes[i]); byte_in(bytes[6]^1); fault_check;
 reset;
 byte_in(8'haa); byte_in(0); repeat(32010) @(negedge clk); fault_check;
 reset;
 byte_in(8'haa); byte_in(0);
 // Real malformed UART stop bit aborts the in-flight parser transaction.
 release dut.rx_data; release dut.rx_valid;
 rx=0; repeat(16*10) @(negedge clk); rx=1;
 repeat(16) @(negedge clk); fault_check;
 if(dut.parser.position!=0) $fatal(1,"FAIL framing parser abort");
 mode=1; reset;
 if(!dut.echo_mode) $fatal(1,"FAIL mode latch");
 mode=0; repeat(20) @(negedge clk);
 if(!dut.echo_mode) $fatal(1,"FAIL mode changed during replay");
 mode=0; reset;
 if(dut.echo_mode) $fatal(1,"FAIL detector mode reset");
 $display("PASS top fault invalidation, parser timeout/framing abort, reset, mode latch"); $finish;
end
initial begin #2000000; $fatal(1,"FAIL fault test timeout"); end
endmodule
